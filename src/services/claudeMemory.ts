// ABOUTME: Frontend service for the Claude Code auto-memory interceptor.
// ABOUTME: Starts/stops the Rust watcher that persists intercepted files to SerenDB.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { projectStore } from "@/stores/project.store";

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

export interface InterceptSuccessEvent {
  path: string;
  name: string | null;
  memory_type: string;
  serendb_response: string;
}

export interface InterceptFailureEvent {
  path: string;
  memory_type: string;
  error: string;
}

function getActiveProjectId(): string | null {
  return projectStore.activeProject?.id ?? null;
}

/**
 * Start the filesystem watcher. The Rust side intercepts every `.md` write
 * in `~/.claude/projects/*\/memory/`, awaits a real SerenDB write for each
 * file, and only deletes the plaintext file once the cloud write succeeds.
 *
 * Requires an authenticated SerenDB session and an active project UUID.
 */
export async function startClaudeMemoryInterceptor(): Promise<ClaudeMemoryStatus> {
  if (!isTauriRuntime()) {
    return { running: false, watching_root: null };
  }
  const projectId = getActiveProjectId();
  return invoke<ClaudeMemoryStatus>("claude_memory_start", { projectId });
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
 */
export async function migrateExistingClaudeMemory(): Promise<ClaudeMemoryMigrationReport> {
  if (!isTauriRuntime()) {
    return { persisted: 0, failures: 0 };
  }
  const projectId = getActiveProjectId();
  return invoke<ClaudeMemoryMigrationReport>("claude_memory_migrate_existing", {
    projectId,
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
 * Render `~/.claude/projects/<encoded(projectCwd)>/MEMORY.md` from the user's
 * authenticated SerenDB memory bootstrap, so Claude Code reads fresh content
 * at the start of its next session.
 */
export async function renderClaudeMemoryMd(
  projectCwd: string,
): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const projectId = getActiveProjectId();
  return invoke<string>("claude_memory_render_memory_md", {
    projectCwd,
    projectId,
  });
}
