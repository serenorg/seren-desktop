// ABOUTME: Critical tests for the Claude Code auto-memory interceptor service.
// ABOUTME: Verifies the frontend wrapper dispatches to the correct Tauri commands.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, projectStoreMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  projectStoreMock: {
    activeProject: { id: "project-1" } as { id: string } | null,
  },
  isTauriMock: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: isTauriMock,
}));

vi.mock("@/stores/project.store", () => ({
  projectStore: projectStoreMock,
}));

import {
  getClaudeMemoryStatus,
  migrateExistingClaudeMemory,
  renderClaudeMemoryMd,
  startClaudeMemoryInterceptor,
  stopClaudeMemoryInterceptor,
} from "@/services/claudeMemory";

describe("claudeMemory service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(true);
    projectStoreMock.activeProject = { id: "project-1" };
  });

  it("dispatches start/stop/status to the correct Tauri commands", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "claude_memory_start") {
        return { running: true, watching_root: "/home/a/.claude/projects" };
      }
      if (command === "claude_memory_stop") {
        return { running: false, watching_root: null };
      }
      if (command === "claude_memory_status") {
        return { running: true, watching_root: "/home/a/.claude/projects" };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const started = await startClaudeMemoryInterceptor();
    const status = await getClaudeMemoryStatus();
    const stopped = await stopClaudeMemoryInterceptor();

    expect(started.running).toBe(true);
    expect(started.watching_root).toBe("/home/a/.claude/projects");
    expect(status.running).toBe(true);
    expect(stopped.running).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_start");
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_status");
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_stop");
  });

  it("returns the migrated count from migrate_existing", async () => {
    invokeMock.mockResolvedValue(7);
    const count = await migrateExistingClaudeMemory();
    expect(count).toBe(7);
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_migrate_existing");
  });

  it("passes the active SerenDB project id when rendering MEMORY.md", async () => {
    invokeMock.mockResolvedValue("/home/a/.claude/projects/-proj/MEMORY.md");
    await renderClaudeMemoryMd("/home/a/Projects/proj");
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_render_memory_md", {
      projectCwd: "/home/a/Projects/proj",
      projectId: "project-1",
    });
  });

  it("no-ops in non-Tauri runtime", async () => {
    isTauriMock.mockReturnValue(false);
    const started = await startClaudeMemoryInterceptor();
    const status = await getClaudeMemoryStatus();
    const migrated = await migrateExistingClaudeMemory();
    expect(started).toEqual({ running: false, watching_root: null });
    expect(status).toEqual({ running: false, watching_root: null });
    expect(migrated).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
