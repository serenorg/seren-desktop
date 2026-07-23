// ABOUTME: Protects provider restore de-duplication, replay tagging, and prompt acceptance boundaries.
// ABOUTME: Uses provider seams only; no agent process or network is required.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — provider runtime files are plain ESM without generated declarations.
import {
  _sendAcpRequest,
  createAcpRuntime,
} from "../../bin/browser-local/acp-runtime.mjs";
// @ts-expect-error — provider runtime files are plain ESM without generated declarations.
import {
  _replayClaudeHistoryEntry,
  _writeClaudeMessageAccepted,
  createClaudeRuntime,
} from "../../bin/browser-local/claude-runtime.mjs";
// @ts-expect-error — provider runtime files are plain ESM without generated declarations.
import {
  _replayCodexThreadItems,
  createProviderHandlers,
  createSynchronousSpawnCoordinator,
  shouldFallbackCodexResume,
} from "../../bin/browser-local/providers.mjs";

function createCodexProcessHarness() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const processHandle = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    pid: 42,
    kill: vi.fn(),
    stdin: {
      write: vi.fn((line: string) => {
        const request = JSON.parse(line.trim());
        if (request.id == null) return true;

        let result: unknown = {};
        if (request.method === "model/list") result = { data: [] };
        if (request.method === "thread/start") {
          result = { thread: { id: "native-codex" } };
        }
        if (request.method === "turn/start") {
          result = { turn: { id: "turn-1" } };
        }
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        });
        return true;
      }),
    },
  });

  return {
    processHandle,
    notify(method: string, params: unknown) {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
  };
}

describe("provider local-session spawn coordination", () => {
  it("claims the local ID synchronously and joins one compatible spawn flight", async () => {
    let releaseList: (sessions: unknown[]) => void = () => {};
    const listSessions = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          releaseList = resolve;
        }),
    );
    const spawn = vi.fn(async () => ({
      id: "local-1",
      agentType: "codex",
      cwd: "/project",
      status: "ready",
      agentSessionId: "native-1",
    }));
    const emit = vi.fn();
    const coordinate = createSynchronousSpawnCoordinator({
      spawn,
      listSessions,
      emit,
    });
    const spec = {
      localSessionId: "local-1",
      agentType: "codex",
      cwd: "/project",
      resumeAgentSessionId: "native-1",
      requireExactResume: true,
    };

    const owner = coordinate(spec);
    const joiner = coordinate(spec);

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    releaseList([]);

    await expect(owner).resolves.toMatchObject({
      id: "local-1",
      reused: false,
      owned: true,
    });
    await expect(joiner).resolves.toMatchObject({
      id: "local-1",
      reused: true,
      owned: false,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("provider://session-status", {
      sessionId: "local-1",
      status: "ready",
      agentSessionId: "native-1",
    });
  });

  it("reuses only an exact ready agent/cwd/native binding", async () => {
    const spawn = vi.fn();
    const emit = vi.fn();
    const existing = {
      id: "local-1",
      agentType: "claude-code",
      cwd: "/project",
      status: "ready",
      agentSessionId: "native-1",
    };
    const coordinate = createSynchronousSpawnCoordinator({
      spawn,
      listSessions: async () => [existing],
      emit,
    });

    await expect(
      coordinate({
        localSessionId: "local-1",
        agentType: "claude-code",
        cwd: "/project",
        resumeAgentSessionId: "native-1",
        requireExactResume: true,
      }),
    ).resolves.toMatchObject({
      reused: true,
      owned: false,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("provider://session-status", {
      sessionId: "local-1",
      status: "ready",
      agentSessionId: "native-1",
    });
  });

  it("rejects an incompatible native ID instead of spawning a duplicate", async () => {
    const spawn = vi.fn();
    const coordinate = createSynchronousSpawnCoordinator({
      spawn,
      listSessions: async () => [
        {
          id: "local-1",
          agentType: "codex",
          cwd: "/project",
          status: "ready",
          agentSessionId: "other-native",
        },
      ],
      emit: vi.fn(),
    });

    await expect(
      coordinate({
        localSessionId: "local-1",
        agentType: "codex",
        cwd: "/project",
        resumeAgentSessionId: "native-1",
        requireExactResume: true,
      }),
    ).rejects.toThrow(/different native session ID/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("joins compatible desktop and Happy flights despite different replay flags", async () => {
    let releaseList: (sessions: unknown[]) => void = () => {};
    const spawn = vi.fn(async () => ({
      id: "local-1",
      agentType: "codex",
      cwd: "/project",
      status: "ready",
      agentSessionId: "native-1",
    }));
    const coordinate = createSynchronousSpawnCoordinator({
      spawn,
      listSessions: () =>
        new Promise<unknown[]>((resolve) => {
          releaseList = resolve;
        }),
      emit: vi.fn(),
    });

    const desktop = coordinate({
      localSessionId: "local-1",
      agentType: "codex",
      cwd: "/project",
      resumeAgentSessionId: "native-1",
    });
    const happy = coordinate({
      localSessionId: "local-1",
      agentType: "codex",
      cwd: "/project",
      resumeAgentSessionId: "native-1",
      requireExactResume: true,
      suppressHistoryReplay: true,
    });
    releaseList([]);

    await expect(desktop).resolves.toMatchObject({ owned: true });
    await expect(happy).resolves.toMatchObject({
      reused: true,
      owned: false,
      agentSessionId: "native-1",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("enforces an exact joiner's native ID against the resolved winning flight", async () => {
    let releaseList: (sessions: unknown[]) => void = () => {};
    const coordinate = createSynchronousSpawnCoordinator({
      spawn: async () => ({
        id: "local-1",
        agentType: "codex",
        cwd: "/project",
        status: "ready",
        agentSessionId: "different-native",
      }),
      listSessions: () =>
        new Promise<unknown[]>((resolve) => {
          releaseList = resolve;
        }),
      emit: vi.fn(),
    });

    const desktop = coordinate({
      localSessionId: "local-1",
      agentType: "codex",
      cwd: "/project",
    });
    const happy = coordinate({
      localSessionId: "local-1",
      agentType: "codex",
      cwd: "/project",
      resumeAgentSessionId: "native-1",
      requireExactResume: true,
      suppressHistoryReplay: true,
    });
    releaseList([]);

    await expect(desktop).resolves.toMatchObject({ owned: true });
    await expect(happy).rejects.toThrow(/different native session ID/);
  });
});

describe("provider exact-resume contract", () => {
  it("never treats a recoverable Codex resume error as permission to start fresh", () => {
    expect(shouldFallbackCodexResume(new Error("thread not found"), false)).toBe(
      true,
    );
    expect(shouldFallbackCodexResume(new Error("thread not found"), true)).toBe(
      false,
    );
  });

  it("requires a native ID before exact Codex or Claude restore", async () => {
    const codex = createProviderHandlers({ emit: vi.fn() });
    await expect(
      codex.spawnSession({
        localSessionId: "local-codex",
        agentType: "codex",
        cwd: "/project",
        requireExactResume: true,
      }),
    ).rejects.toThrow(/exact resume requires a native agent session ID/);

    const claude = createClaudeRuntime({ emit: vi.fn() });
    await expect(
      claude.spawnSession({
        localSessionId: "local-claude",
        cwd: "/project",
        requireExactResume: true,
      }),
    ).rejects.toThrow(/exact resume requires a native agent session ID/);
  });

  it("rejects unsupported ACP exact resume before spawning a child", async () => {
    const spawnProcess = vi.fn();
    const runtime = createAcpRuntime({
      emit: vi.fn(),
      adapter: {
        agentType: "synthetic-acp",
        agentName: "Synthetic ACP",
        spawnProcess,
      },
    });

    await expect(
      runtime.spawnSession({
        localSessionId: "local-acp",
        cwd: "/project",
        requireExactResume: true,
        resumeAgentSessionId: "native-acp",
      }),
    ).rejects.toThrow(/does not support exact ACP session resume/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe("provider replay tagging", () => {
  it("marks replayed Codex tool start and end events", () => {
    const emit = vi.fn();
    _replayCodexThreadItems(
      emit,
      { id: "local-1", toolOutputs: new Map() },
      {
        turns: [
          {
            items: [
              {
                id: "tool-1",
                type: "commandExecution",
                command: "synthetic command",
                status: "completed",
                output: "synthetic output",
              },
            ],
          },
        ],
      },
    );

    expect(emit).toHaveBeenCalledWith(
      "provider://tool-call",
      expect.objectContaining({ toolCallId: "tool-1", replay: true }),
    );
    expect(emit).toHaveBeenCalledWith(
      "provider://tool-result",
      expect.objectContaining({ toolCallId: "tool-1", replay: true }),
    );
  });

  it("marks replayed Claude tool start and end events", () => {
    const emit = vi.fn();
    const session = { id: "local-1", toolInputs: new Map() };
    _replayClaudeHistoryEntry(emit, session, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { path: "synthetic.txt" },
          },
        ],
      },
    });
    _replayClaudeHistoryEntry(emit, session, {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "synthetic result",
          },
        ],
      },
    });

    expect(emit).toHaveBeenCalledWith(
      "provider://tool-call",
      expect.objectContaining({ toolCallId: "tool-1", replay: true }),
    );
    expect(emit).toHaveBeenCalledWith(
      "provider://tool-result",
      expect.objectContaining({ toolCallId: "tool-1", replay: true }),
    );
  });
});

describe("provider prompt acceptance writes", () => {
  it("ends the Codex submit RPC at turn acceptance and events a late failure", async () => {
    const emit = vi.fn();
    const processHarness = createCodexProcessHarness();
    const handlers = createProviderHandlers({
      emit,
      spawnCodex: vi.fn(() => processHarness.processHandle),
    });
    await handlers.spawnSession({
      localSessionId: "local-codex",
      agentType: "codex",
      cwd: "/project",
    });

    await expect(
      handlers.submitPrompt({
        sessionId: "local-codex",
        prompt: "synthetic prompt",
        source: "remote",
      }),
    ).resolves.toEqual({ accepted: true, sessionId: "local-codex" });

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(handlers.listSessions()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "local-codex", status: "prompting" }),
        ]),
      );

      processHarness.notify("turn/completed", {
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "synthetic late failure" },
        },
      });
      await Promise.resolve();
      expect(emit).toHaveBeenCalledWith("provider://error", {
        sessionId: "local-codex",
        error: "synthetic late failure",
      });
    } finally {
      vi.useRealTimers();
      await handlers.terminateSession({ sessionId: "local-codex" });
    }
  });

  it("acknowledges ACP only from the stdin write callback", async () => {
    let writeCallback: ((error?: Error | null) => void) | undefined;
    const onWritten = vi.fn();
    const session = {
      nextRequestId: 1,
      pendingRequests: new Map(),
      process: {
        stdin: {
          write: vi.fn((_line: string, callback: (error?: Error | null) => void) => {
            writeCallback = callback;
            return true;
          }),
        },
      },
    };

    const request = _sendAcpRequest(
      session,
      "session/prompt",
      { prompt: [] },
      1_000,
      { onWritten },
    );
    expect(onWritten).not.toHaveBeenCalled();
    writeCallback?.();
    expect(onWritten).toHaveBeenCalledTimes(1);

    const pending = session.pendingRequests.get("1");
    clearTimeout(pending.timeout);
    session.pendingRequests.delete("1");
    pending.resolve({ stopReason: "end_turn" });
    await expect(request).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("acknowledges Claude only after its stdin write callback succeeds", async () => {
    let writeCallback: ((error?: Error | null) => void) | undefined;
    const session = {
      process: {
        stdin: {
          write: vi.fn((_line: string, callback: (error?: Error | null) => void) => {
            writeCallback = callback;
            return true;
          }),
        },
      },
    };

    const accepted = _writeClaudeMessageAccepted(session, {
      type: "user",
      message: { content: "synthetic prompt" },
    });
    let settled = false;
    void accepted.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    writeCallback?.();
    await expect(accepted).resolves.toBeUndefined();
  });
});
