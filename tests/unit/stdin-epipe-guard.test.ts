// ABOUTME: Regression tests for #3432 — an EPIPE `error` event on an agent
// ABOUTME: child's stdin must fail only that session, never crash the shared
// ABOUTME: provider-runtime helper hosting every live agent session.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — provider runtime files are plain ESM without generated declarations.
import { createAcpRuntime } from "../../bin/browser-local/acp-runtime.mjs";
// @ts-expect-error — provider runtime files are plain ESM without generated declarations.
import { createProviderHandlers } from "../../bin/browser-local/providers.mjs";

/**
 * Fake agent child speaking newline-delimited JSON-RPC over stdio. stdin is an
 * EventEmitter (like the real Socket) so the runtime's stdin `error` listener
 * can be attached and the EPIPE crash mechanism reproduced faithfully: an
 * `error` event on an EventEmitter with no listener throws — in production,
 * an uncaughtException that kills the whole helper process.
 */
function createJsonRpcChildHarness(respond: (method: string) => unknown) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      const request = JSON.parse(line.trim());
      if (request.id == null) return true;
      queueMicrotask(() => {
        stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: respond(request.method),
          })}\n`,
        );
      });
      return true;
    }),
  });
  const processHandle = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    // pid stays undefined so killChildTree never reaches its win32 taskkill
    // branch — a fake pid must not be able to target a real OS process.
    pid: undefined,
    kill: vi.fn(),
    stdin,
  });
  return { processHandle, stdin };
}

function epipeError() {
  return Object.assign(new Error("write EPIPE"), {
    code: "EPIPE",
    syscall: "write",
  });
}

describe("#3432 — Codex stdin EPIPE fails one session, not the helper", () => {
  it("attaches a stdin error listener at spawn and escalates to a kill", async () => {
    const emit = vi.fn();
    const harness = createJsonRpcChildHarness((method) => {
      if (method === "model/list") return { data: [] };
      if (method === "thread/start") return { thread: { id: "native-codex" } };
      return {};
    });
    const handlers = createProviderHandlers({
      emit,
      spawnCodex: vi.fn(() => harness.processHandle),
    });
    await handlers.spawnSession({
      localSessionId: "local-codex",
      agentType: "codex",
      cwd: "/project",
    });

    expect(harness.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => harness.stdin.emit("error", epipeError())).not.toThrow();

    // The guard hard-kills the child so the exit handler — the existing
    // cleanup path for a child that had started — fails just this session.
    expect(harness.processHandle.kill).toHaveBeenCalled();
    harness.processHandle.emit("exit", null, "SIGTERM");

    await expect(handlers.listSessions()).resolves.toEqual([]);
    expect(emit).toHaveBeenCalledWith(
      "provider://session-status",
      expect.objectContaining({
        sessionId: "local-codex",
        status: "terminated",
      }),
    );
  });
});

describe("#3432 — ACP stdin EPIPE fails one session, not the helper", () => {
  it("attaches a stdin error listener at spawn and escalates to a kill", async () => {
    const emit = vi.fn();
    const harness = createJsonRpcChildHarness((method) => {
      if (method === "initialize") {
        return { agentInfo: { version: "0.0.0" }, agentCapabilities: {} };
      }
      if (method === "session/new") return { sessionId: "native-acp" };
      return {};
    });
    const runtime = createAcpRuntime({
      emit,
      adapter: {
        agentType: "synthetic-acp",
        agentName: "Synthetic ACP",
        defaultModeId: "default",
        defaultModelId: "synthetic-model",
        availableModels: [{ modelId: "synthetic-model", name: "Synthetic" }],
        buildModes: (session: { currentModeId?: string }) => ({
          currentModeId: session?.currentModeId ?? "default",
          availableModes: [{ modeId: "default", name: "Default" }],
        }),
        resolveInitialMode: () => "default",
        isAuthError: () => false,
        stoppedBeforeRequestMessage:
          "Synthetic ACP stopped before request completed.",
        processExitedWhilePromptMessage:
          "Synthetic ACP exited while prompt was active.",
        spawnProcess: () => harness.processHandle,
      },
    });
    await runtime.spawnSession({ localSessionId: "local-acp", cwd: "/project" });

    expect(harness.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => harness.stdin.emit("error", epipeError())).not.toThrow();

    // The guard hard-kills the child so `close` — the single cleanup path —
    // fails just this session.
    expect(harness.processHandle.kill).toHaveBeenCalled();
    harness.processHandle.emit("close");

    await expect(runtime.listSessions()).resolves.toEqual([]);
    expect(emit).toHaveBeenCalledWith(
      "provider://session-status",
      expect.objectContaining({
        sessionId: "local-acp",
        status: "terminated",
      }),
    );
  });
});

describe("#3432 — Claude runtime stdin guard (source-level)", () => {
  // Claude spawnSession resolves a real CLI binary and runs the stream-json
  // handshake, so it cannot be driven with an injected fake child the way the
  // Codex and ACP runtimes can. The behavioral EPIPE path is exercised above
  // through the runtimes sharing the same attach-at-spawn pattern; this guard
  // pins the Claude wiring in source.
  const source = readFileSync(
    resolve("bin/browser-local/claude-runtime.mjs"),
    "utf-8",
  );

  function extractAttachProcessListenersBody(): string {
    const start = source.indexOf("function attachProcessListeners(");
    if (start < 0) return "";
    const after = source.indexOf("\nfunction ", start + 1);
    return after < 0 ? source.slice(start) : source.slice(start, after);
  }

  it("attachProcessListeners installs a stdin error listener that kills the child", () => {
    const body = extractAttachProcessListenersBody();
    expect(body, "attachProcessListeners body must be non-empty").not.toBe("");

    const stdinIdx = body.indexOf('session.process.stdin.on("error"');
    expect(
      stdinIdx,
      "attachProcessListeners must attach a stdin error listener (#3432).",
    ).toBeGreaterThan(-1);

    const killIdx = body.indexOf("killChildTree", stdinIdx);
    expect(
      killIdx,
      "the stdin error listener must escalate to killChildTree so the exit handler fails the session.",
    ).toBeGreaterThan(stdinIdx);

    expect(
      body.indexOf('session.process.on("exit"'),
      "the exit handler — the single cleanup path — must still exist.",
    ).toBeGreaterThan(-1);
  });
});
