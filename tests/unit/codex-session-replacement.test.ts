// ABOUTME: Regression coverage for #3654: a late event from a terminated
// ABOUTME: Codex child must not delete a same-id replacement session.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — provider runtime files are plain ESM without generated declarations.
import { createProviderHandlers } from "../../bin/browser-local/providers.mjs";

function createCodexChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      const request = JSON.parse(line.trim());
      if (request.id == null) return true;
      const result =
        request.method === "model/list"
          ? { data: [] }
          : request.method === "thread/start"
            ? { thread: { id: "native-codex" } }
            : {};
      queueMicrotask(() => {
        stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
        );
      });
      return true;
    }),
  });
  const processHandle = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    pid: undefined,
    kill: vi.fn(),
  });
  return processHandle;
}

describe("#3654 — Codex same-id replacement ownership", () => {
  it("keeps the replacement when the terminated child exits late", async () => {
    const firstChild = createCodexChild();
    const secondChild = createCodexChild();
    const spawnCodex = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const handlers = createProviderHandlers({ emit: vi.fn(), spawnCodex });
    const params = {
      localSessionId: "stable-codex-session",
      agentType: "codex",
      cwd: "/project",
    };

    await handlers.spawnSession(params);
    await handlers.terminateSession({ sessionId: params.localSessionId });
    await handlers.spawnSession(params);

    firstChild.emit("exit", null, "SIGTERM");

    await expect(handlers.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: params.localSessionId,
        agentType: "codex",
        status: "ready",
      }),
    ]);
  });
});
