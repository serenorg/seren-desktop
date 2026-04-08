// ABOUTME: Frontend service for the Claude Code auto-memory interceptor.
// ABOUTME: Starts/stops the Rust watcher and renders MEMORY.md from SerenDB on demand.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { projectStore } from "@/stores/project.store";

export interface ClaudeMemoryStatus {
  running: boolean;
  watching_root: string | null;
}

export interface ClaudeMemoryProjectIdentity {
  identifier: string;
  source: "git_remote" | "persisted_uuid" | "generated_uuid";
}

export interface InterceptEvent {
  path: string;
  name: string | null;
  memory_type: string;
  persisted_id: string;
  deleted: boolean;
}

/**
 * Start the filesystem watcher that intercepts Claude Code memory writes.
 */
export async function startClaudeMemoryInterceptor(): Promise<ClaudeMemoryStatus> {
  if (!isTauriRuntime()) {
    return { running: false, watching_root: null };
  }
  return invoke<ClaudeMemoryStatus>("claude_memory_start");
}

/**
 * Stop the watcher. Safe to call even if it is not running.
 */
export async function stopClaudeMemoryInterceptor(): Promise<ClaudeMemoryStatus> {
  if (!isTauriRuntime()) {
    return { running: false, watching_root: null };
  }
  return invoke<ClaudeMemoryStatus>("claude_memory_stop");
}

/**
 * Read the current watcher status without mutating it.
 */
export async function getClaudeMemoryStatus(): Promise<ClaudeMemoryStatus> {
  if (!isTauriRuntime()) {
    return { running: false, watching_root: null };
  }
  return invoke<ClaudeMemoryStatus>("claude_memory_status");
}

/**
 * Walk every existing Claude memory directory and migrate any plaintext files
 * already on disk. Returns the number migrated.
 */
export async function migrateExistingClaudeMemory(): Promise<number> {
  if (!isTauriRuntime()) {
    return 0;
  }
  return invoke<number>("claude_memory_migrate_existing");
}

/**
 * Resolve a stable identifier for a project directory. Uses the git remote URL
 * when available, otherwise a persisted UUID at `<cwd>/.claude/project_id`.
 */
export async function getClaudeProjectIdentity(
  projectCwd: string,
): Promise<ClaudeMemoryProjectIdentity | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  return invoke<ClaudeMemoryProjectIdentity>(
    "claude_memory_get_project_identity",
    {
      projectCwd,
    },
  );
}

/**
 * Render `~/.claude/projects/<encoded(projectCwd)>/MEMORY.md` from the user's
 * SerenDB memory bootstrap. Should be called when the user opens a project so
 * that Claude Code reads fresh content on its next session start.
 */
export async function renderClaudeMemoryMd(
  projectCwd: string,
): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const projectId = projectStore.activeProject?.id ?? null;
  return invoke<string>("claude_memory_render_memory_md", {
    projectCwd,
    projectId,
  });
}
