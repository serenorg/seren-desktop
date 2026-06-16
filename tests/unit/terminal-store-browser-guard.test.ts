// ABOUTME: Regression test for #2238 — browser/dev startup must not call Tauri terminal event APIs.
// ABOUTME: Keeps terminalStore.init safe for Vite/Playwright browser-mode smoke runs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { isTauriRuntimeMock, invokeMock, listenMock, unlistenMock } = vi.hoisted(
  () => ({
    isTauriRuntimeMock: vi.fn<() => boolean>(),
    invokeMock: vi.fn(),
    listenMock: vi.fn(),
    unlistenMock: vi.fn(),
  }),
);

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

describe("terminalStore browser runtime guard", () => {
  beforeEach(() => {
    vi.resetModules();
    isTauriRuntimeMock.mockReset();
    invokeMock.mockReset();
    listenMock.mockReset();
    unlistenMock.mockReset();
  });

  it("marks initialized in browser mode without touching Tauri APIs", async () => {
    isTauriRuntimeMock.mockReturnValue(false);
    invokeMock.mockRejectedValue(new Error("browser mode must not invoke"));
    listenMock.mockRejectedValue(new Error("browser mode must not listen"));

    const { terminalStore } = await import("@/stores/terminal.store");

    await expect(terminalStore.init()).resolves.toBeUndefined();

    expect(terminalStore.buffers).toEqual([]);
    expect(listenMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("still binds terminal exit listener and loads buffers in Tauri", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    listenMock.mockResolvedValue(unlistenMock);
    invokeMock.mockResolvedValue([
      {
        id: "terminal-1",
        title: "Terminal",
        cwd: "/tmp",
        command: null,
        cols: 100,
        rows: 28,
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const { terminalStore } = await import("@/stores/terminal.store");

    await terminalStore.init();

    expect(listenMock).toHaveBeenCalledWith(
      "terminal://exit",
      expect.any(Function),
    );
    expect(invokeMock).toHaveBeenCalledWith("terminal_list_buffers");
    expect(terminalStore.buffers).toHaveLength(1);
    terminalStore.dispose();
    expect(unlistenMock).toHaveBeenCalledOnce();
  });
});

describe("terminalStore CLI launch helpers", () => {
  it("builds normal and YOLO startup commands for Claude and Codex", async () => {
    const { terminalCommandForCliLaunch, terminalTitleForCliLaunch } =
      await import("@/stores/terminal.store");

    expect(terminalCommandForCliLaunch("claude", "normal")).toBe("claude");
    expect(terminalCommandForCliLaunch("claude", "yolo")).toBe(
      "claude --dangerously-skip-permissions",
    );
    expect(terminalCommandForCliLaunch("codex", "normal")).toBe("codex");
    expect(terminalCommandForCliLaunch("codex", "yolo")).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox",
    );
    expect(terminalTitleForCliLaunch("claude", "yolo")).toBe(
      "Claude Code CLI (YOLO)",
    );
    expect(terminalTitleForCliLaunch("codex", "yolo")).toBe(
      "Codex CLI (YOLO)",
    );
  });
});
