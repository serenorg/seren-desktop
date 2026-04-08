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

  it("start passes the active SerenDB project id to Rust", async () => {
    invokeMock.mockResolvedValue({
      running: true,
      watching_root: "/home/a/.claude/projects",
    });
    const status = await startClaudeMemoryInterceptor();
    expect(status.running).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("claude_memory_start", {
      projectId: "project-1",
    });
  });

  it("stop and status call the correct commands without project context", async () => {
    invokeMock.mockResolvedValueOnce({ running: false, watching_root: null });
    invokeMock.mockResolvedValueOnce({ running: false, watching_root: null });
    await stopClaudeMemoryInterceptor();
    await getClaudeMemoryStatus();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "claude_memory_stop");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "claude_memory_status");
  });

  it("migrate returns the persisted+failures report", async () => {
    invokeMock.mockResolvedValue({ persisted: 7, failures: 2 });
    const report = await migrateExistingClaudeMemory();
    expect(report).toEqual({ persisted: 7, failures: 2 });
    expect(invokeMock).toHaveBeenCalledWith(
      "claude_memory_migrate_existing",
      { projectId: "project-1" },
    );
  });

  it("render forwards projectCwd and projectId", async () => {
    invokeMock.mockResolvedValue("/home/a/.claude/projects/-proj/MEMORY.md");
    await renderClaudeMemoryMd("/home/a/Projects/proj");
    expect(invokeMock).toHaveBeenCalledWith(
      "claude_memory_render_memory_md",
      { projectCwd: "/home/a/Projects/proj", projectId: "project-1" },
    );
  });

  it("no-ops in non-Tauri runtime (never calls invoke)", async () => {
    isTauriMock.mockReturnValue(false);
    const started = await startClaudeMemoryInterceptor();
    const status = await getClaudeMemoryStatus();
    const migrated = await migrateExistingClaudeMemory();
    expect(started).toEqual({ running: false, watching_root: null });
    expect(status).toEqual({ running: false, watching_root: null });
    expect(migrated).toEqual({ persisted: 0, failures: 0 });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
