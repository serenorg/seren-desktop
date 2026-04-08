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
  ensureClaudeMemoryProvisioned,
  getClaudeMemoryStatus,
  migrateExistingClaudeMemory,
  startClaudeMemoryInterceptor,
  stopClaudeMemoryInterceptor,
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
    databasesMock.runSql.mockResolvedValueOnce({
      columns: [],
      row_count: 0,
      rows: [],
    });

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

    // DDL was applied (CREATE TABLE for claude_agent_preferences) and
    // routed to the correct database name.
    expect(databasesMock.runSql).toHaveBeenCalledTimes(1);
    const [pid, bid, dbName, sql, readOnly] =
      databasesMock.runSql.mock.calls[0]!;
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
    databasesMock.runSql.mockResolvedValueOnce({
      columns: [],
      row_count: 0,
      rows: [],
    });

    const result = await ensureClaudeMemoryProvisioned();
    expect(result.projectId).toBe("existing-claude-proj");
    expect(result.branchId).toBe("existing-branch");
    expect(result.databaseName).toBe("claude_agent_prefs");

    // Must NOT create a duplicate project or database.
    expect(databasesMock.createProject).not.toHaveBeenCalled();
    expect(databasesMock.createDatabase).not.toHaveBeenCalled();
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
    invokeMock.mockResolvedValue({ persisted: 7, failures: 2 });

    const report = await migrateExistingClaudeMemory();
    expect(report).toEqual({ persisted: 7, failures: 2 });
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_migrate_existing", {
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
    expect(migrated).toEqual({ persisted: 0, failures: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(databasesMock.listProjects).not.toHaveBeenCalled();
  });
});
