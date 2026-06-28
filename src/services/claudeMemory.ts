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
 *
 * The `returned http <status>` markers anchor on the Rust formatter at
 * `src-tauri/src/claude_memory.rs::SerenDbSqlClient::run_sql` (which emits
 * `"SerenDB query returned HTTP {status}: {body}"`). 408 is the canonical
 * empty-body edge-timeout signature when the SerenDB SQL backend is cold;
 * 502/503/504 cover gateway-level transients during deploys, restarts, and
 * saturation. 5xx responses that carry a concrete body (e.g. 500 carrying
 * "Failed to connect to target database") still match via the connection
 * markers above. #1845.
 */
const DATABASE_NOT_READY_MARKERS = [
  "failed to connect to target database",
  "database not ready",
  "connection refused",
  "returned http 408",
  "returned http 502",
  "returned http 503",
  "returned http 504",
];

function isDatabaseNotReadyError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return DATABASE_NOT_READY_MARKERS.some((marker) => msg.includes(marker));
}

/**
 * Run a single SQL statement against SerenDB, retrying through the readiness
 * marker set above when the failure looks like a cold backend or a gateway
 * transient. The DDL leg of `ensureClaudeMemoryProvisioned` and the
 * `SELECT 1` probe in `waitForDatabaseReady` both go through this helper so
 * each leg gets the full 180-second cold-start budget — a single 408 on
 * either path used to crash the entire interceptor start (#1845).
 *
 * The query must be safe to re-run on retry. The Claude memory DDL is
 * idempotent (`CREATE TABLE IF NOT EXISTS`), and the readiness probe is
 * `SELECT 1`. Do not pass non-idempotent statements through here.
 */
async function runSqlWithReadinessRetry(
  projectId: string,
  branchId: string,
  databaseName: string,
  query: string,
  readOnly: boolean,
  maxAttempts: number = DATABASE_READY_MAX_ATTEMPTS,
  delayMs: number = DATABASE_READY_DELAY_MS,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<unknown> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await databases.runSql(
        projectId,
        branchId,
        databaseName,
        query,
        readOnly,
      );
      if (attempt > 1) {
        console.info(
          `[ClaudeMemory] database "${databaseName}" served query after ${attempt} attempts`,
        );
      }
      return result;
    } catch (err) {
      if (!isDatabaseNotReadyError(err)) {
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
  // Exhausted the loop without returning or throwing — unreachable with the
  // bounds above, but TypeScript can't prove it.
  throw new Error("runSqlWithReadinessRetry exhausted without resolving");
}

/**
 * Poll a database with `SELECT 1` until it responds successfully, the
 * error stops looking like a cold-start, or we hit the max attempt count.
 * Returns once the database is queryable; throws on terminal errors or
 * timeout.
 *
 * Thin wrapper around `runSqlWithReadinessRetry`. A freshly-created SerenDB
 * database is NOT immediately queryable via the `/query` endpoint — the
 * metadata write returns fast, but the Postgres backend takes seconds
 * (sometimes tens of seconds) to provision. The only safe pattern is:
 * create → poll until ready → DDL.
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
  await runSqlWithReadinessRetry(
    projectId,
    branchId,
    databaseName,
    "SELECT 1",
    /* readOnly */ true,
    maxAttempts,
    delayMs,
    sleepFn,
  );
}

export interface ClaudeMemoryStatus {
  running: boolean;
  watching_root: string | null;
}

export interface ClaudeMemoryMigrationReport {
  persisted: number;
  failures: number;
  rendered: number;
  render_failures: number;
}

export interface ClaudeMemoryPreference {
  pref_key: string;
  pref_type: string;
  description: string | null;
  content: string;
  source_file: string | null;
  updated_at: string | null;
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
  rendered_memory_md: string | null;
  render_error: string | null;
}

export interface InterceptFailureEvent {
  path: string;
  memory_type: string;
  error: string;
}

/**
 * A user-facing notice for a failed interceptor start. `status` is the parsed
 * HTTP status (for telemetry); `message` is body-free copy safe to show in a
 * dialog.
 */
export interface MemoryStartFailureNotice {
  status: number | undefined;
  message: string;
}

/**
 * Map a Claude-memory interceptor start failure to an actionable, body-free
 * user notice. Branches on the failure class — auth/permission (401/403),
 * billing (402), still-provisioning (missing key), other non-retryable client
 * errors (400/404/409/422), and retryable transients (408/429/5xx/network) —
 * so each reads differently and only the genuinely-retryable bucket promises an
 * automatic retry. The dialog never echoes raw server bodies (which can include
 * an HTTP 403 payload). The status is parsed from the `returned HTTP <status>`
 * marker that both the Rust `run_sql` formatter and the seren-db service errors
 * emit. #2497 Defect 3; #2506.
 */
export function classifyMemoryStartFailure(
  error: unknown,
): MemoryStartFailureNotice {
  const raw = error instanceof Error ? error.message : String(error);
  const statusMatch = /returned HTTP (\d{3})/i.exec(raw);
  const status = statusMatch?.[1]
    ? Number.parseInt(statusMatch[1], 10)
    : undefined;

  // Auth/permission failure — not transient. "Toggle it off and on" won't help.
  if (status === 401 || status === 403) {
    return {
      status,
      message:
        "Seren couldn't authorize memory storage for your account. This usually means your account is still finishing setup. Sign out and back in, or try again in a few minutes. If it keeps happening, contact support.",
    };
  }

  // Quota exceeded / payment required — retrying never helps; the user must top
  // up. seren-core returns 402 for this on the seren-db path. #2506.
  if (status === 402) {
    return {
      status,
      message:
        "Seren memory storage needs an active plan or balance on your account. Add funds in Settings → Wallet, then retry from Settings → Code Indexing → Claude Code Auto-Memory.",
    };
  }

  // The desktop API key hasn't landed yet — a transient provisioning failure
  // upstream kept the session but left no key. Re-authenticating re-mints it.
  if (/api key not available/i.test(raw)) {
    return {
      status,
      message:
        "Seren is still finishing your account setup, so memory storage isn't ready yet. Sign out and back in, or try again shortly.",
    };
  }

  // Other non-retryable client errors — no organization (400), no active plan
  // (404), conflict (409), unprocessable (422). These will NOT self-heal, so we
  // must not promise an automatic retry. seren-core#187 documents 400/404 here.
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return {
      status,
      message:
        "Seren couldn't set up memory storage for your account. Sign out and back in, and contact support if it keeps happening.",
    };
  }

  // Everything else (5xx, 408, 429, gateway timeout, network, cold-start
  // exhaustion) is transient and self-heals on the next memory write.
  return {
    status,
    message:
      "Seren couldn't reach memory storage just now. It will retry automatically on the next memory write — you can also retry from Settings → Code Indexing → Claude Code Auto-Memory.",
  };
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

  // Apply the table DDL through the same readiness-retry helper as the
  // SELECT 1 probe. The DDL is idempotent (CREATE TABLE IF NOT EXISTS), and
  // a cold backend or transient gateway 408/502/503/504 between the probe
  // and the DDL must not collapse the whole start (#1845).
  console.info(
    `[ClaudeMemory] applying claude_agent_preferences DDL to ${CLAUDE_MEMORY_DATABASE_NAME}`,
  );
  await runSqlWithReadinessRetry(
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
 * files to SerenDB. Returns persisted, cloud-write failures, refreshed
 * MEMORY.md indexes, and refresh failures. Files whose cloud write fails are
 * left on disk so the live watcher can retry later.
 *
 * Provisions the SerenDB project/database/table first if needed.
 */
export async function migrateExistingClaudeMemory(): Promise<ClaudeMemoryMigrationReport> {
  if (!isTauriRuntime()) {
    return { persisted: 0, failures: 0, rendered: 0, render_failures: 0 };
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
 * Render `~/.claude/projects/<encoded(projectCwd)>/memory/MEMORY.md` from the
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

/**
 * Recall one Claude Code auto-memory body from SerenDB by `pref_key`.
 * This is the supported read path for bodies listed in MEMORY.md; the
 * original sibling `.md` files are removed after a successful cloud write.
 */
export async function recallClaudeMemoryPreference(
  projectCwd: string,
  prefKey: string,
): Promise<ClaudeMemoryPreference | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const provisioning = await ensureClaudeMemoryProvisioned();
  return invoke<ClaudeMemoryPreference | null>(
    "claude_memory_recall_preference",
    {
      projectCwd,
      prefKey,
      projectId: provisioning.projectId,
      branchId: provisioning.branchId,
      databaseName: provisioning.databaseName,
    },
  );
}
