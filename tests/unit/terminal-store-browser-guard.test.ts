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
    vi.unstubAllGlobals();
    isTauriRuntimeMock.mockReset();
    invokeMock.mockReset();
    listenMock.mockReset();
    unlistenMock.mockReset();
  });

  it("uses the global CLI launch-mode default for new CLI buffers only", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    listenMock.mockResolvedValue(unlistenMock);
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value);
        }),
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { request?: unknown }) => {
      if (cmd === "terminal_list_buffers") return Promise.resolve([]);
      if (cmd === "terminal_create_buffer") {
        const request = args?.request as Record<string, unknown>;
        return Promise.resolve({
          id: request.id ?? `buffer-${invokeMock.mock.calls.length}`,
          title: request.title,
          cliKind: request.cliKind,
          launchMode: request.launchMode,
          sessionId: request.sessionId ?? null,
          sessionResumable: request.sessionResumable ?? false,
          cwd: request.cwd,
          cols: 100,
          rows: 28,
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        });
      }
      return Promise.resolve(undefined);
    });

    const { terminalStore } = await import("@/stores/terminal.store");
    terminalStore.setDefaultCliLaunchMode("yolo");
    expect(storage.get("seren:terminal-cli-launch-mode")).toBe("yolo");

    await terminalStore.createBuffer({ cliKind: "claude" });
    await terminalStore.createBuffer({ title: "Terminal" });

    const createCalls = invokeMock.mock.calls.filter(
      (call) => call[0] === "terminal_create_buffer",
    );
    expect(createCalls[0][1].request).toMatchObject({
      cliKind: "claude",
      launchMode: "yolo",
      command: undefined,
    });
    expect(createCalls[1][1].request).toMatchObject({
      cliKind: null,
      launchMode: "normal",
    });
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

  it("restoreAgents resumes each auto-restore descriptor with its session", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    listenMock.mockResolvedValue(unlistenMock);
    const descriptors = [
      {
        id: "claude-1",
        title: "Claude Code CLI",
        cliKind: "claude",
        launchMode: "yolo",
        cwd: "/work/a",
        sessionId: "11111111-1111-4111-8111-111111111111",
        sessionResumable: true,
        autoRestore: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "codex-skip",
        title: "Codex CLI",
        cliKind: "codex",
        launchMode: "normal",
        cwd: "/work/b",
        sessionId: null,
        sessionResumable: false,
        autoRestore: false,
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    invokeMock.mockImplementation((cmd: string, args?: { request?: unknown }) => {
      if (cmd === "terminal_list_buffers") return Promise.resolve([]);
      if (cmd === "terminal_list_agent_descriptors")
        return Promise.resolve(descriptors);
      if (cmd === "terminal_create_buffer") {
        const request = args?.request as Record<string, unknown>;
        return Promise.resolve({
          id: request.id,
          title: request.title,
          cliKind: request.cliKind,
          launchMode: request.launchMode,
          sessionId: request.sessionId ?? null,
          sessionResumable: request.sessionResumable ?? false,
          cwd: request.cwd,
          cols: 100,
          rows: 28,
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        });
      }
      return Promise.resolve(undefined);
    });

    const { terminalStore } = await import("@/stores/terminal.store");
    await terminalStore.restoreAgents();

    const createCalls = invokeMock.mock.calls.filter(
      (call) => call[0] === "terminal_create_buffer",
    );
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0][1].request).toMatchObject({
      id: "claude-1",
      cliKind: "claude",
      launchMode: "yolo",
      resume: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionResumable: true,
    });
  });

  it("restoreAgents keeps each descriptor's launch mode over the global default", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    listenMock.mockResolvedValue(unlistenMock);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => "yolo"),
        setItem: vi.fn(),
      },
    });
    invokeMock.mockImplementation((cmd: string, args?: { request?: unknown }) => {
      if (cmd === "terminal_list_buffers") return Promise.resolve([]);
      if (cmd === "terminal_list_agent_descriptors") {
        return Promise.resolve([
          {
            id: "normal-claude",
            title: "Claude Code CLI",
            cliKind: "claude",
            launchMode: "normal",
            cwd: "/work",
            sessionId: "11111111-1111-4111-8111-111111111111",
            sessionResumable: true,
            autoRestore: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ]);
      }
      if (cmd === "terminal_create_buffer") {
        const request = args?.request as Record<string, unknown>;
        return Promise.resolve({
          id: request.id,
          title: request.title,
          cliKind: request.cliKind,
          launchMode: request.launchMode,
          sessionId: request.sessionId ?? null,
          sessionResumable: request.sessionResumable ?? false,
          cwd: request.cwd,
          cols: 100,
          rows: 28,
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        });
      }
      return Promise.resolve(undefined);
    });

    const { terminalStore } = await import("@/stores/terminal.store");
    await terminalStore.restoreAgents();

    const createCall = invokeMock.mock.calls.find(
      (call) => call[0] === "terminal_create_buffer",
    );
    expect(createCall?.[1].request).toMatchObject({
      id: "normal-claude",
      launchMode: "normal",
      resume: true,
    });
  });

  it("restoreAgents forgets descriptors that do not have a resumable session yet", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    listenMock.mockResolvedValue(unlistenMock);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "terminal_list_agent_descriptors") {
        return Promise.resolve([
          {
            id: "empty-claude",
            title: "Claude Code CLI",
            cliKind: "claude",
            launchMode: "normal",
            cwd: "/work",
            sessionId: "11111111-1111-4111-8111-111111111111",
            sessionResumable: false,
            autoRestore: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ]);
      }
      return Promise.resolve(undefined);
    });

    const { terminalStore } = await import("@/stores/terminal.store");
    await terminalStore.restoreAgents();

    expect(invokeMock).not.toHaveBeenCalledWith(
      "terminal_create_buffer",
      expect.anything(),
    );
    expect(invokeMock).toHaveBeenCalledWith("terminal_forget_agent", {
      bufferId: "empty-claude",
    });
  });

  it("restartBuffer schedules Codex session capture when the restarted process has no session id", async () => {
    vi.useFakeTimers();
    try {
      isTauriRuntimeMock.mockReturnValue(true);
      listenMock.mockResolvedValue(unlistenMock);
      invokeMock.mockImplementation(
        (cmd: string, args?: { bufferId?: string; request?: unknown }) => {
          if (cmd === "terminal_list_buffers") {
            return Promise.resolve([
              {
                id: "codex-1",
                instanceId: "instance-1",
                title: "Codex CLI",
                cliKind: "codex",
                launchMode: "normal",
                sessionId: null,
                sessionResumable: false,
                cwd: "/work",
                cols: 100,
                rows: 28,
                status: "running",
                createdAt: 1,
                updatedAt: 1,
              },
            ]);
          }
          if (cmd === "terminal_restart_buffer") {
            const request = args?.request as Record<string, unknown>;
            return Promise.resolve({
              id: args?.bufferId,
              instanceId: "instance-2",
              title: request.title,
              cliKind: request.cliKind,
              launchMode: request.launchMode,
              sessionId: null,
              sessionResumable: false,
              cwd: request.cwd,
              cols: 100,
              rows: 28,
              status: "running",
              createdAt: 1,
              updatedAt: 2,
            });
          }
          if (cmd === "terminal_capture_session_id") {
            return Promise.resolve(
              "11111111-1111-4111-8111-111111111111",
            );
          }
          return Promise.resolve(undefined);
        },
      );

      const { terminalStore } = await import("@/stores/terminal.store");
      await terminalStore.init();
      await terminalStore.restartBuffer("codex-1", {
        cliKind: "codex",
        launchMode: "yolo",
      });
      await vi.advanceTimersByTimeAsync(3000);

      const restartCall = invokeMock.mock.calls.find(
        (call) => call[0] === "terminal_restart_buffer",
      );
      expect(restartCall?.[1].request).toMatchObject({
        expectedInstanceId: "instance-1",
      });
      expect(invokeMock).toHaveBeenCalledWith("terminal_capture_session_id", {
        bufferId: "codex-1",
      });
      expect(terminalStore.getBuffer("codex-1")?.sessionId).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("terminalStore CLI launch helpers", () => {
  it("builds stable titles while Rust owns CLI command composition", async () => {
    const { terminalTitleForCliLaunch } = await import(
      "@/stores/terminal.store"
    );

    expect(terminalTitleForCliLaunch("claude", "yolo")).toBe(
      "Claude Code CLI",
    );
    expect(terminalTitleForCliLaunch("codex", "yolo")).toBe("Codex CLI");
  });
});
