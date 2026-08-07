// ABOUTME: Verifies the composite session source routes per-session calls to the owning source.
// ABOUTME: Protects provider sessions from a failing terminal listing.

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import { createCompositeSource } from "../../bin/happy-bridge/composite-source.mjs";

function stubSource(sessions: Array<{ sessionId: string }>) {
  return {
    listSessions: vi.fn(async () => sessions),
    subscribe: vi.fn(() => () => {}),
    sendPrompt: vi.fn(async () => ({ accepted: true })),
    cancel: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => ({ ok: true })),
    respondToDiffProposal: vi.fn(async () => ({ ok: true })),
    setPermissionMode: vi.fn(async () => {}),
    spawn: vi.fn(async () => ({ sessionId: "spawned" })),
    advertise: vi.fn(async () => ({ machineName: "mac", agents: [], roots: [] })),
    close: vi.fn(),
  };
}

describe("composite session source", () => {
  it("lists provider and terminal sessions together", async () => {
    const provider = stubSource([{ sessionId: "provider-1" }]);
    const terminal = stubSource([{ sessionId: "terminal-1" }]);
    const source = createCompositeSource({ provider, terminal });

    await expect(source.listSessions()).resolves.toEqual([
      { sessionId: "provider-1" },
      { sessionId: "terminal-1" },
    ]);
  });

  it("keeps provider sessions when the terminal listing fails", async () => {
    const provider = stubSource([{ sessionId: "provider-1" }]);
    const terminal = stubSource([]);
    terminal.listSessions.mockRejectedValue(new Error("supervisor RPC timed out"));
    const source = createCompositeSource({ provider, terminal });

    await expect(source.listSessions()).resolves.toEqual([{ sessionId: "provider-1" }]);
  });

  it("routes a prompt to the source that owns the session", async () => {
    const provider = stubSource([{ sessionId: "provider-1" }]);
    const terminal = stubSource([{ sessionId: "terminal-1" }]);
    const source = createCompositeSource({ provider, terminal });
    await source.listSessions();

    await source.sendPrompt("terminal-1", "hello");
    await source.sendPrompt("provider-1", "hello");

    expect(terminal.sendPrompt).toHaveBeenCalledWith("terminal-1", "hello");
    expect(provider.sendPrompt).toHaveBeenCalledWith("provider-1", "hello");
    expect(terminal.sendPrompt).toHaveBeenCalledTimes(1);
    expect(provider.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("claims ownership from an event before the session is ever listed", async () => {
    const provider = stubSource([]);
    const terminal = stubSource([]);
    let publish: ((event: { sessionId: string }) => void) | null = null;
    terminal.subscribe.mockImplementation((onEvent: (event: { sessionId: string }) => void) => {
      publish = onEvent;
      return () => {};
    });
    const source = createCompositeSource({ provider, terminal });
    source.subscribe(() => {});

    publish?.({ sessionId: "terminal-late" });
    await source.terminate("terminal-late");

    expect(terminal.terminate).toHaveBeenCalledWith("terminal-late");
    expect(provider.terminate).not.toHaveBeenCalled();
  });

  it("always spawns through the provider — panes are opened on the desktop", async () => {
    const provider = stubSource([]);
    const terminal = stubSource([]);
    const source = createCompositeSource({ provider, terminal });

    await source.spawn({ agentType: "claude-code", cwd: "/tmp" });

    expect(provider.spawn).toHaveBeenCalledTimes(1);
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("sends an unknown session to the provider, which owns spawning", async () => {
    const provider = stubSource([]);
    const terminal = stubSource([]);
    const source = createCompositeSource({ provider, terminal });

    await source.cancel("just-spawned");

    expect(provider.cancel).toHaveBeenCalledWith("just-spawned");
    expect(terminal.cancel).not.toHaveBeenCalled();
  });
});
