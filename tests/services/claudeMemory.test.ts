// ABOUTME: Critical tests for the Claude Code auto-memory interceptor service.
// ABOUTME: Verifies auto-provisioning of the SerenDB project + database + table on first run.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  invokeMock,
  isTauriMock,
  databasesMock,
  settingsState,
  settingsStoreMock,
} = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    claudeMemoryProjectId: null,
    claudeMemoryBranchId: null,
    claudeMemoryDatabaseName: null,
    claudeMemoryInterceptEnabled: true,
    claudeMemoryMigrateOnStartup: true,
  };
  return {
    invokeMock: vi.fn(),
    isTauriMock: vi.fn(() => true),
    databasesMock: {
      listProjects: vi.fn(),
      createProject: vi.fn(),
      listBranches: vi.fn(),
      listDatabases: vi.fn(),
      createDatabase: vi.fn(),
      runSql: vi.fn(),
    },
    settingsState: state,
    settingsStoreMock: {
      get: vi.fn((key: string) => state[key]),
      set: vi.fn((key: string, value: unknown) => {
        state[key] = value;
      }),
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: isTauriMock,
}));

vi.mock("@/services/databases", () => ({
  databases: databasesMock,
}));

vi.mock("@/stores/settings.store", () => ({
  settingsStore: settingsStoreMock,
}));

import {
  classifyMemoryStartFailure,
  ensureClaudeMemoryProvisioned,
  getClaudeMemoryStatus,
  migrateExistingClaudeMemory,
  renderClaudeMemoryMd,
  startClaudeMemoryInterceptor,
  stopClaudeMemoryInterceptor,
  waitForDatabaseReady,
} from "@/services/claudeMemory";

function resetMocks() {
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(true);
  settingsState.claudeMemoryProjectId = null;
  settingsState.claudeMemoryBranchId = null;
  settingsState.claudeMemoryDatabaseName = null;
  settingsState.claudeMemoryInterceptEnabled = true;
  settingsState.claudeMemoryMigrateOnStartup = true;
}

describe("ensureClaudeMemoryProvisioned", () => {
  beforeEach(resetMocks);

  it("auto-creates project, database, and applies DDL on first run", async () => {
    // No existing project / database — first-run path.
    databasesMock.listProjects.mockResolvedValueOnce([]);
    databasesMock.createProject.mockResolvedValueOnce({
      id: "proj-uuid",
      name: "claude-agent-prefs",
    });
    databasesMock.listBranches.mockResolvedValueOnce([
      { id: "branch-uuid", name: "main" },
    ]);
    databasesMock.listDatabases
      .mockResolvedValueOnce([]) // first lookup before create
      .mockResolvedValueOnce([
        { id: "db-uuid", name: "claude_agent_prefs" },
      ]); // re-fetch after create
    databasesMock.createDatabase.mockResolvedValueOnce({
      id: "db-uuid",
      name: "claude_agent_prefs",
      branch_id: "branch-uuid",
    });
    // First runSql call is the readiness poll's `SELECT 1`; second is the DDL.
    databasesMock.runSql
      .mockResolvedValueOnce({ columns: ["?column?"], row_count: 1, rows: [[1]] })
      .mockResolvedValueOnce({ columns: [], row_count: 0, rows: [] });

    const result = await ensureClaudeMemoryProvisioned();
    expect(result).toEqual({
      projectId: "proj-uuid",
      branchId: "branch-uuid",
      databaseName: "claude_agent_prefs",
    });

    // Project + database creation happened exactly once each.
    expect(databasesMock.createProject).toHaveBeenCalledWith(
      "claude-agent-prefs",
    );
    expect(databasesMock.createDatabase).toHaveBeenCalledWith(
      "proj-uuid",
      "branch-uuid",
      "claude_agent_prefs",
    );

    // Two runSql calls now: the SELECT 1 readiness poll, then the DDL.
    expect(databasesMock.runSql).toHaveBeenCalledTimes(2);
    const readinessCall = databasesMock.runSql.mock.calls[0]!;
    expect(readinessCall[3]).toBe("SELECT 1"); // the probe
    expect(readinessCall[4]).toBe(true); // read-only

    const ddlCall = databasesMock.runSql.mock.calls[1]!;
    const [pid, bid, dbName, sql, readOnly] = ddlCall;
    expect(pid).toBe("proj-uuid");
    expect(bid).toBe("branch-uuid");
    expect(dbName).toBe("claude_agent_prefs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS claude_agent_preferences");
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS claude_agent_preference_audit",
    );
    expect(sql).toContain("UNIQUE(project_path, pref_key)");
    expect(readOnly).toBe(false);

    // IDs are persisted to settings so subsequent runs hit the fast path.
    expect(settingsStoreMock.set).toHaveBeenCalledWith(
      "claudeMemoryProjectId",
      "proj-uuid",
    );
    expect(settingsStoreMock.set).toHaveBeenCalledWith(
      "claudeMemoryBranchId",
      "branch-uuid",
    );
    expect(settingsStoreMock.set).toHaveBeenCalledWith(
      "claudeMemoryDatabaseName",
      "claude_agent_prefs",
    );
  });

  it("reuses persisted IDs on subsequent runs (fast path)", async () => {
    settingsState.claudeMemoryProjectId = "cached-proj";
    settingsState.claudeMemoryBranchId = "cached-branch";
    settingsState.claudeMemoryDatabaseName = "cached-db";

    const result = await ensureClaudeMemoryProvisioned();
    expect(result).toEqual({
      projectId: "cached-proj",
      branchId: "cached-branch",
      databaseName: "cached-db",
    });

    // Fast path MUST NOT call any of the discovery/creation paths.
    expect(databasesMock.listProjects).not.toHaveBeenCalled();
    expect(databasesMock.createProject).not.toHaveBeenCalled();
    expect(databasesMock.listBranches).not.toHaveBeenCalled();
    expect(databasesMock.listDatabases).not.toHaveBeenCalled();
    expect(databasesMock.createDatabase).not.toHaveBeenCalled();
    expect(databasesMock.runSql).not.toHaveBeenCalled();
  });

  // #1845: A transient 408 on the DDL leg used to crash the entire
  // interceptor start because the DDL was not wrapped in the same retry the
  // readiness probe uses. Both legs must absorb cold-start blips.
  it("survives a transient HTTP 408 on the DDL and persists IDs once it succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      databasesMock.listProjects.mockResolvedValueOnce([
        { id: "warm-proj", name: "claude-agent-prefs" },
      ]);
      databasesMock.listBranches.mockResolvedValueOnce([
        { id: "warm-branch", name: "main" },
      ]);
      databasesMock.listDatabases.mockResolvedValueOnce([
        { id: "warm-db", name: "claude_agent_prefs" },
      ]);
      // SELECT 1 succeeds, DDL fails once with 408 then succeeds.
      databasesMock.runSql
        .mockResolvedValueOnce({ columns: ["?column?"], row_count: 1, rows: [[1]] })
        .mockRejectedValueOnce(new Error("SerenDB query returned HTTP 408: "))
        .mockResolvedValueOnce({ columns: [], row_count: 0, rows: [] });

      const promise = ensureClaudeMemoryProvisioned();
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({
        projectId: "warm-proj",
        branchId: "warm-branch",
        databaseName: "claude_agent_prefs",
      });
      // Three calls: probe + DDL-fail + DDL-success. The DDL retry is what
      // saves a session that would otherwise have crashed at start.
      expect(databasesMock.runSql).toHaveBeenCalledTimes(3);
      const ddlAttempt = databasesMock.runSql.mock.calls[2]!;
      expect(ddlAttempt[3]).toContain(
        "CREATE TABLE IF NOT EXISTS claude_agent_preferences",
      );
      // Persistence runs only after the DDL succeeds — proves recovery is end-to-end.
      expect(settingsStoreMock.set).toHaveBeenCalledWith(
        "claudeMemoryProjectId",
        "warm-proj",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses an existing claude-agent-prefs project if one is found", async () => {
    // No persisted IDs, but the project already exists in the user's
    // SerenDB account from a previous machine or manual creation.
    databasesMock.listProjects.mockResolvedValueOnce([
      { id: "existing-proj", name: "some-other-project" },
      { id: "existing-claude-proj", name: "claude-agent-prefs" },
    ]);
    databasesMock.listBranches.mockResolvedValueOnce([
      { id: "existing-branch", name: "main" },
    ]);
    databasesMock.listDatabases.mockResolvedValueOnce([
      { id: "existing-db", name: "claude_agent_prefs" },
    ]);
    // Readiness probe then DDL.
    databasesMock.runSql
      .mockResolvedValueOnce({ columns: ["?column?"], row_count: 1, rows: [[1]] })
      .mockResolvedValueOnce({ columns: [], row_count: 0, rows: [] });

    const result = await ensureClaudeMemoryProvisioned();
    expect(result.projectId).toBe("existing-claude-proj");
    expect(result.branchId).toBe("existing-branch");
    expect(result.databaseName).toBe("claude_agent_prefs");

    // Must NOT create a duplicate project or database.
    expect(databasesMock.createProject).not.toHaveBeenCalled();
    expect(databasesMock.createDatabase).not.toHaveBeenCalled();
  });
});

describe("waitForDatabaseReady", () => {
  beforeEach(resetMocks);

  it("retries while the database is not ready and resolves when it becomes queryable", async () => {
    // Two "Failed to connect to target database" errors then success on the third attempt.
    databasesMock.runSql
      .mockRejectedValueOnce(
        new Error(
          "SerenDB query failed: HTTP 500 Internal error: Failed to connect to target database",
        ),
      )
      .mockRejectedValueOnce(
        new Error(
          "SerenDB query failed: HTTP 500 Internal error: Failed to connect to target database",
        ),
      )
      .mockResolvedValueOnce({
        columns: ["?column?"],
        row_count: 1,
        rows: [[1]],
      });

    const sleepMock = vi.fn(async (_ms: number) => {
      /* no-op */
    });
    await waitForDatabaseReady(
      "proj",
      "branch",
      "claude_agent_prefs",
      /* maxAttempts */ 5,
      /* delayMs */ 10,
      sleepMock,
    );

    // Exactly 3 attempts: two failures + one success.
    expect(databasesMock.runSql).toHaveBeenCalledTimes(3);
    // sleep was called twice (between the 3 attempts).
    expect(sleepMock).toHaveBeenCalledTimes(2);
    // Each call should be the SELECT 1 probe against the right database.
    for (const call of databasesMock.runSql.mock.calls) {
      expect(call[2]).toBe("claude_agent_prefs");
      expect(call[3]).toBe("SELECT 1");
      expect(call[4]).toBe(true);
    }
  });

  it("fails fast on non-connection errors instead of burning the full budget", async () => {
    // A permission error is terminal — no point retrying for 60 seconds.
    databasesMock.runSql.mockRejectedValueOnce(
      new Error("SerenDB query failed: HTTP 403 forbidden"),
    );

    const sleepMock = vi.fn(async () => {
      /* no-op */
    });
    await expect(
      waitForDatabaseReady(
        "proj",
        "branch",
        "claude_agent_prefs",
        /* maxAttempts */ 10,
        /* delayMs */ 10,
        sleepMock,
      ),
    ).rejects.toThrow(/403/);

    // Must NOT have retried on a non-connection error.
    expect(databasesMock.runSql).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts of persistent connection failures", async () => {
    databasesMock.runSql.mockRejectedValue(
      new Error("Internal error: Failed to connect to target database"),
    );
    const sleepMock = vi.fn(async () => {
      /* no-op */
    });
    await expect(
      waitForDatabaseReady(
        "proj",
        "branch",
        "claude_agent_prefs",
        /* maxAttempts */ 3,
        /* delayMs */ 10,
        sleepMock,
      ),
    ).rejects.toThrow(/did not become ready after 3 attempts/);
    expect(databasesMock.runSql).toHaveBeenCalledTimes(3);
  });

  // #1845: empty-body 408s from /publishers/seren-db/query are the canonical
  // edge-timeout shape when the SerenDB SQL backend is cold. The retry loop
  // must absorb them; otherwise a single transient 408 collapses the entire
  // 180s cold-start budget.
  it.each([408, 502, 503, 504])(
    "retries on transient HTTP %i and resolves on success",
    async (status) => {
      databasesMock.runSql
        .mockRejectedValueOnce(
          new Error(`SerenDB query returned HTTP ${status}: `),
        )
        .mockResolvedValueOnce({ columns: ["?column?"], row_count: 1, rows: [[1]] });

      const sleepMock = vi.fn(async () => {
        /* no-op */
      });
      await waitForDatabaseReady(
        "proj",
        "branch",
        "claude_agent_prefs",
        5,
        10,
        sleepMock,
      );
      expect(databasesMock.runSql).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledTimes(1);
    },
  );

  it("still fails fast on terminal HTTP 401", async () => {
    // Auth failures must not be swallowed by the retry loop — there is no
    // amount of waiting that fixes a missing API key.
    databasesMock.runSql.mockRejectedValueOnce(
      new Error("SerenDB query returned HTTP 401: Unauthorized"),
    );
    const sleepMock = vi.fn(async () => {
      /* no-op */
    });
    await expect(
      waitForDatabaseReady(
        "proj",
        "branch",
        "claude_agent_prefs",
        10,
        10,
        sleepMock,
      ),
    ).rejects.toThrow(/401/);
    expect(databasesMock.runSql).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });
});

describe("startClaudeMemoryInterceptor wiring", () => {
  beforeEach(resetMocks);

  it("provisions then forwards (projectId, branchId, databaseName) to the Tauri start command", async () => {
    settingsState.claudeMemoryProjectId = "p";
    settingsState.claudeMemoryBranchId = "b";
    settingsState.claudeMemoryDatabaseName = "d";
    invokeMock.mockResolvedValue({
      running: true,
      watching_root: "/home/a/.claude/projects",
    });

    const status = await startClaudeMemoryInterceptor();
    expect(status.running).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_start", {
      projectId: "p",
      branchId: "b",
      databaseName: "d",
    });
  });

  it("stop and status hit the correct commands without provisioning", async () => {
    invokeMock.mockResolvedValueOnce({ running: false, watching_root: null });
    invokeMock.mockResolvedValueOnce({ running: false, watching_root: null });
    await stopClaudeMemoryInterceptor();
    await getClaudeMemoryStatus();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "claude_memory_stop");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "claude_memory_status");
  });

  it("migrate provisions then forwards (projectId, branchId, databaseName)", async () => {
    settingsState.claudeMemoryProjectId = "p";
    settingsState.claudeMemoryBranchId = "b";
    settingsState.claudeMemoryDatabaseName = "d";
    invokeMock.mockResolvedValue({
      persisted: 7,
      failures: 2,
      rendered: 3,
      render_failures: 1,
    });

    const report = await migrateExistingClaudeMemory();
    expect(report).toEqual({
      persisted: 7,
      failures: 2,
      rendered: 3,
      render_failures: 1,
    });
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_migrate_existing", {
      projectId: "p",
      branchId: "b",
      databaseName: "d",
    });
  });

  it("render provisions then forwards the project cwd to the Tauri render command", async () => {
    settingsState.claudeMemoryProjectId = "p";
    settingsState.claudeMemoryBranchId = "b";
    settingsState.claudeMemoryDatabaseName = "d";
    invokeMock.mockResolvedValue(
      "/home/a/.claude/projects/-home-a-proj/memory/MEMORY.md",
    );

    const path = await renderClaudeMemoryMd("/home/a/proj");
    expect(path).toBe(
      "/home/a/.claude/projects/-home-a-proj/memory/MEMORY.md",
    );
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_render_memory_md", {
      projectCwd: "/home/a/proj",
      projectId: "p",
      branchId: "b",
      databaseName: "d",
    });
  });

  it("no-ops in non-Tauri runtime (never calls invoke or databases)", async () => {
    isTauriMock.mockReturnValue(false);
    const started = await startClaudeMemoryInterceptor();
    const status = await getClaudeMemoryStatus();
    const migrated = await migrateExistingClaudeMemory();
    expect(started).toEqual({ running: false, watching_root: null });
    expect(status).toEqual({ running: false, watching_root: null });
    expect(migrated).toEqual({
      persisted: 0,
      failures: 0,
      rendered: 0,
      render_failures: 0,
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(databasesMock.listProjects).not.toHaveBeenCalled();
  });
});

describe("classifyMemoryStartFailure (#2497 Defect 3)", () => {
  it("treats 401/403 as a non-transient auth/permission failure", () => {
    for (const status of [401, 403]) {
      const notice = classifyMemoryStartFailure(
        new Error(`serendb SELECT failed: SerenDB query returned HTTP ${status}: {"message":"forbidden"}`),
      );
      expect(notice.status).toBe(status);
      expect(notice.message.toLowerCase()).toContain("authorize");
      // Never echoes the raw server body or the toggle-off-and-on advice.
      expect(notice.message).not.toContain("forbidden");
      expect(notice.message).not.toMatch(/toggling it off and on/i);
    }
  });

  it("explains that the desktop key is still provisioning when it is absent", () => {
    const notice = classifyMemoryStartFailure(
      new Error(
        "SerenDB API key not available — log in to Seren Desktop so the key is provisioned",
      ),
    );
    expect(notice.status).toBeUndefined();
    expect(notice.message.toLowerCase()).toContain("finishing");
    expect(notice.message).not.toContain("log in to Seren Desktop so the key");
  });

  it("treats 408/429/5xx / gateway timeouts as transient with an auto-retry promise", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const notice = classifyMemoryStartFailure(
        new Error(`SerenDB query returned HTTP ${status}: upstream`),
      );
      expect(notice.status).toBe(status);
      expect(notice.message.toLowerCase()).toContain("retry automatically");
      expect(notice.message).not.toContain("upstream");
    }
  });

  it("defaults to the transient auto-retry notice for status-less errors", () => {
    const notice = classifyMemoryStartFailure(new Error("network unreachable"));
    expect(notice.status).toBeUndefined();
    expect(notice.message.toLowerCase()).toContain("retry automatically");
  });

  it("treats 402 as a billing wall (top up), never an auto-retry (#2506)", () => {
    const notice = classifyMemoryStartFailure(
      new Error(
        'Failed to create project: returned HTTP 402: {"error":"quota exceeded"}',
      ),
    );
    expect(notice.status).toBe(402);
    expect(notice.message.toLowerCase()).toContain("plan or balance");
    expect(notice.message).toMatch(/Settings → Wallet/);
    // Must NOT promise an automatic retry, and must not leak the raw body.
    expect(notice.message).not.toContain("retry automatically");
    expect(notice.message).not.toContain("quota exceeded");
  });

  it("treats 400/404/409/422 as non-retryable setup errors, never auto-retry (#2506)", () => {
    for (const status of [400, 404, 409, 422]) {
      const notice = classifyMemoryStartFailure(
        new Error(
          `Failed to create project: returned HTTP ${status}: {"error":"no active plan"}`,
        ),
      );
      expect(notice.status).toBe(status);
      expect(notice.message.toLowerCase()).toContain("set up memory storage");
      expect(notice.message).not.toContain("retry automatically");
      expect(notice.message).not.toContain("no active plan");
    }
  });
});
