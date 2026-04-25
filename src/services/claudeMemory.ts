// ABOUTME: Frontend service for the Claude Code auto-memory interceptor.
// ABOUTME: Auto-provisions a SerenDB project + database + table on first run.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { databases } from "@/services/databases";
import { settingsStore } from "@/stores/settings.store";

/**
 * Name of the SerenDB project that holds Claude Code memory. Per #1492 / #1509,
 * this is auto-created on first run if absent. The user can change which
 * project the interceptor uses via the Settings dropdowns (future).
 */
const CLAUDE_MEMORY_PROJECT_NAME = "claude-agent-prefs";

/**
 * Name of the SerenDB database inside the Claude memory project. Auto-created
 * on first run if absent.
 */
const CLAUDE_MEMORY_DATABASE_NAME = "claude_agent_prefs";

/**
 * DDL for the `claude_agent_preferences` table per #1492 spec. Idempotent
 * (uses IF NOT EXISTS) so re-running on every provision check is safe.
 *
 * NOTE: Claude memory is structured rows in this table — NOT memory SDK
 * records. This is a separate store from the user's conversational memory.
 */
const CLAUDE_MEMORY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS claude_agent_preferences (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  pref_key TEXT NOT NULL,
  pref_type TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  source_file TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_path, pref_key)
);
CREATE TABLE IF NOT EXISTS claude_agent_preference_audit (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  pref_key TEXT NOT NULL,
  action TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
`.trim();

/**
 * How many times to poll a freshly-created database for readiness before
 * giving up. With a 2-second delay between attempts this gives ~3 minutes
 * total for the database's Postgres backend to finish provisioning.
 *
 * The original budget was 30 attempts / 60s, which was insufficient for
 * first-run cold-start provisioning on Windows (reported in #1524): a
 * user who upgrades to a version with auto-memory for the first time
 * triggers project + database + Postgres backend creation in one shot,
 * and the backend can take 60-120s to become queryable. 90 attempts
 * (180s) gives a generous margin without changing the 2s poll interval
 * (warm databases still return on the first or second attempt).
 */
const DATABASE_READY_MAX_ATTEMPTS = 90;
const DATABASE_READY_DELAY_MS = 2000;

/**
 * Error substrings that indicate the database exists in the metadata layer
 * but its Postgres backend is not yet routable by the `/query` endpoint.
 * Any of these on a `SELECT 1` means "wait and retry"; any OTHER error is
 * a real problem and should bubble up immediately.
 */
const DATABASE_NOT_READY_MARKERS = [
  "failed to connect to target database",
  "database not ready",
  "connection refused",
];

function isDatabaseNotReadyError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return DATABASE_NOT_READY_MARKERS.some((marker) => msg.includes(marker));
}

/**
 * Poll a database with `SELECT 1` until it responds successfully, the
 * error stops looking like a cold-start, or we hit the max attempt count.
 * Returns once the database is queryable; throws on terminal errors or
 * timeout.
 *
 * This is the "Engineering 101" check the initial #1510 PR was missing:
 * a freshly-created SerenDB database is NOT immediately queryable via the
 * `/query` endpoint. The metadata write returns fast, but the Postgres
 * backend takes seconds (sometimes tens of seconds) to provision. The
 * only safe pattern is: create → poll until ready → DDL.
 */
export async function waitForDatabaseReady(
  projectId: string,
  branchId: string,
  databaseName: string,
  maxAttempts: number = DATABASE_READY_MAX_ATTEMPTS,
  delayMs: number = DATABASE_READY_DELAY_MS,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await databases.runSql(
        projectId,
        branchId,
        databaseName,
        "SELECT 1",
        /* readOnly */ true,
      );
      if (attempt > 1) {
        console.info(
          `[ClaudeMemory] database "${databaseName}" became ready after ${attempt} attempts`,
        );
      }
      return;
    } catch (err) {
      if (!isDatabaseNotReadyError(err)) {
        // Not a cold-start error — surface it immediately instead of
        // burning the whole budget on a permanent failure.
        throw err;
      }
      if (attempt === maxAttempts) {
        const totalSeconds = (maxAttempts * delayMs) / 1000;
        throw new Error(
          `SerenDB database "${databaseName}" did not become ready after ${maxAttempts} attempts (${totalSeconds}s total). ` +
            `This can happen on first run when the database backend is still provisioning. ` +
            `Last error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.debug(
        `[ClaudeMemory] database "${databaseName}" not ready (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms`,
      );
      await sleepFn(delayMs);
    }
  }
}

export interface ClaudeMemoryStatus {
  running: boolean;
  watching_root: string | null;
}

export interface ClaudeMemoryMigrationReport {
  persisted: number;
  failures: number;
}

export interface ClaudeMemoryProjectIdentity {
  identifier: string;
  source: "git_remote" | "persisted_uuid" | "generated_uuid";
}

export interface ClaudeMemoryProvisioning {
  projectId: string;
  branchId: string;
  databaseName: string;
}

export interface InterceptSuccessEvent {
  path: string;
  name: string | null;
  memory_type: string;
}

export interface InterceptFailureEvent {
  path: string;
  memory_type: string;
  error: string;
}

/**
 * Resolve the SerenDB project + branch + database the Claude memory
 * interceptor should write to. Auto-creates anything missing on first run
 * and persists the resolved IDs to settings so subsequent runs reuse them.
 *
 * Idempotent: safe to call on every interceptor start. The DDL is also
 * idempotent (CREATE TABLE IF NOT EXISTS).
 */
export async function ensureClaudeMemoryProvisioned(): Promise<ClaudeMemoryProvisioning> {
  // Fast path: already provisioned and persisted to settings.
  const persistedProject = settingsStore.get("claudeMemoryProjectId");
  const persistedBranch = settingsStore.get("claudeMemoryBranchId");
  const persistedDb = settingsStore.get("claudeMemoryDatabaseName");
  if (persistedProject && persistedBranch && persistedDb) {
    return {
      projectId: persistedProject,
      branchId: persistedBranch,
      databaseName: persistedDb,
    };
  }

  // Discover or create the project. We look up by name to avoid creating
  // duplicates if the user (or a previous run) already made one.
  const allProjects = await databases.listProjects();
  let project = allProjects.find((p) => p.name === CLAUDE_MEMORY_PROJECT_NAME);
  if (!project) {
    console.info(
      `[ClaudeMemory] auto-provisioning SerenDB project "${CLAUDE_MEMORY_PROJECT_NAME}"`,
    );
    project = await databases.createProject(CLAUDE_MEMORY_PROJECT_NAME);
  }

  // Resolve the default branch (every project has a `main` branch on creation).
  const branches = await databases.listBranches(project.id);
  const branch = branches[0];
  if (!branch) {
    throw new Error(
      `SerenDB project "${CLAUDE_MEMORY_PROJECT_NAME}" has no branches; cannot provision Claude memory storage.`,
    );
  }

  // Discover or create the database within that branch.
  const allDatabases = await databases.listDatabases(project.id, branch.id);
  let database = allDatabases.find(
    (d) => d.name === CLAUDE_MEMORY_DATABASE_NAME,
  );
  if (!database) {
    console.info(
      `[ClaudeMemory] auto-provisioning SerenDB database "${CLAUDE_MEMORY_DATABASE_NAME}"`,
    );
    const created = await databases.createDatabase(
      project.id,
      branch.id,
      CLAUDE_MEMORY_DATABASE_NAME,
    );
    // Re-fetch through list so we get the full type (includes owner_name etc).
    const refreshed = await databases.listDatabases(project.id, branch.id);
    database = refreshed.find((d) => d.id === created.id) ?? undefined;
  }
  if (!database) {
    throw new Error(
      `Failed to find or create database "${CLAUDE_MEMORY_DATABASE_NAME}" in SerenDB project "${CLAUDE_MEMORY_PROJECT_NAME}".`,
    );
  }

  // Wait for the database backend to be queryable. A freshly-created
  // SerenDB database is NOT immediately reachable via the `/query`
  // endpoint — the metadata write returns fast, but the Postgres backend
  // takes seconds to provision. Poll SELECT 1 until it responds.
  console.info(
    `[ClaudeMemory] waiting for database "${CLAUDE_MEMORY_DATABASE_NAME}" to become ready`,
  );
  await waitForDatabaseReady(
    project.id,
    branch.id,
    CLAUDE_MEMORY_DATABASE_NAME,
  );

  // Apply the table DDL. Idempotent — uses CREATE TABLE IF NOT EXISTS so
  // running on every start is harmless.
  console.info(
    `[ClaudeMemory] applying claude_agent_preferences DDL to ${CLAUDE_MEMORY_DATABASE_NAME}`,
  );
  await databases.runSql(
    project.id,
    branch.id,
    CLAUDE_MEMORY_DATABASE_NAME,
    CLAUDE_MEMORY_TABLE_DDL,
    /* readOnly */ false,
  );

  // Persist the resolved IDs so subsequent runs hit the fast path.
  settingsStore.set("claudeMemoryProjectId", project.id);
  settingsStore.set("claudeMemoryBranchId", branch.id);
  settingsStore.set("claudeMemoryDatabaseName", CLAUDE_MEMORY_DATABASE_NAME);

  return {
    projectId: project.id,
    branchId: branch.id,
    databaseName: CLAUDE_MEMORY_DATABASE_NAME,
  };
}

/**
 * Start the filesystem watcher.
 *
 * Calls `ensureClaudeMemoryProvisioned()` first so the SerenDB project,
 * database, and table all exist before the watcher starts intercepting files.
 * Then passes the resolved provisioning identifiers to Rust so the watcher's
 * SQL writes know exactly where to land.
 */
export async function startClaudeMemoryInterceptor(): Promise<ClaudeMemoryStatus> {
  if (!isTauriRuntime()) {
    return { running: false, watching_root: null };
  }
  const provisioning = await ensureClaudeMemoryProvisioned();
  return invoke<ClaudeMemoryStatus>("claude_memory_start", {
    projectId: provisioning.projectId,
    branchId: provisioning.branchId,
    databaseName: provisioning.databaseName,
  });
}

/**
 * Stop the watcher. Safe to call when it is not running.
 */
export async function stopClaudeMemoryInterceptor(): Promise<ClaudeMemoryStatus> {
  if (!isTauriRuntime()) {
    return { running: false, watching_root: null };
  }
  return invoke<ClaudeMemoryStatus>("claude_memory_stop");
}

/**
 * Snapshot the watcher's current running state without mutating it.
 */
export async function getClaudeMemoryStatus(): Promise<ClaudeMemoryStatus> {
  if (!isTauriRuntime()) {
    return { running: false, watching_root: null };
  }
  return invoke<ClaudeMemoryStatus>("claude_memory_status");
}

/**
 * Walk every existing Claude memory directory and push any pre-existing `.md`
 * files to SerenDB. Returns persisted + failures counts. Files whose cloud
 * write fails are left on disk so the live watcher can retry later.
 *
 * Provisions the SerenDB project/database/table first if needed.
 */
export async function migrateExistingClaudeMemory(): Promise<ClaudeMemoryMigrationReport> {
  if (!isTauriRuntime()) {
    return { persisted: 0, failures: 0 };
  }
  const provisioning = await ensureClaudeMemoryProvisioned();
  return invoke<ClaudeMemoryMigrationReport>("claude_memory_migrate_existing", {
    projectId: provisioning.projectId,
    branchId: provisioning.branchId,
    databaseName: provisioning.databaseName,
  });
}

/**
 * Resolve a stable identifier for a project directory — git remote URL or a
 * persisted UUID at `<cwd>/.claude/project_id`.
 */
export async function getClaudeProjectIdentity(
  projectCwd: string,
): Promise<ClaudeMemoryProjectIdentity | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  return invoke<ClaudeMemoryProjectIdentity>(
    "claude_memory_get_project_identity",
    { projectCwd },
  );
}

/**
 * Returns true when Claude CLI's session JSONL file exists on disk for the
 * given project cwd + session id. Used by `resumeAgentConversation` to skip
 * `--resume` when the stored session ID points at a missing file (CLI
 * cleaned up old sessions, app reinstall, cross-machine sync) — without this
 * pre-flight, the spawn fails with `code=1: No conversation found with
 * session ID: <id>` and surfaces a "Claude Code request failed" error event.
 * Browser runtime: returns false (no CLI sessions to check). See #1657.
 */
export async function claudeSessionExists(
  projectCwd: string,
  sessionId: string,
): Promise<boolean> {
  if (!isTauriRuntime()) {
    return false;
  }
  return invoke<boolean>("claude_session_exists", { projectCwd, sessionId });
}

/**
 * Render `~/.claude/projects/<encoded(projectCwd)>/MEMORY.md` from the
 * `claude_agent_preferences` SerenDB table, so Claude Code reads fresh
 * content at the start of its next session.
 */
export async function renderClaudeMemoryMd(
  projectCwd: string,
): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const provisioning = await ensureClaudeMemoryProvisioned();
  return invoke<string>("claude_memory_render_memory_md", {
    projectCwd,
    projectId: provisioning.projectId,
    branchId: provisioning.branchId,
    databaseName: provisioning.databaseName,
  });
}
