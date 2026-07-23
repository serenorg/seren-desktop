// ABOUTME: Verifies bridge shutdown aborts and joins an in-flight Happy pairing poll.
// ABOUTME: Protects Windows from exiting while Node's HTTP handles are still active.

import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — the bridge layer is plain ESM without declarations.
import { createHappyLayer } from "../../bin/happy-bridge/happy-layer.mjs";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("Happy pairing shutdown", () => {
  it("retries a reset authorization poll with the same keypair", async () => {
    const publicKeys: string[] = [];
    let requestCount = 0;
    let resolveRetryStarted: (() => void) | undefined;
    const retryStarted = new Promise<void>((resolve) => {
      resolveRetryStarted = resolve;
    });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        publicKeys.push(String(JSON.parse(body).publicKey));
        requestCount += 1;
        if (requestCount === 1) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        if (requestCount === 2) {
          request.socket.destroy();
          return;
        }
        resolveRetryStarted?.();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }

    const layer = createHappyLayer({
      config: {
        machineIdentity: null,
        machineName: "pairing-retry-test",
        relayUrl: `http://127.0.0.1:${address.port}`,
      },
      source: {},
      supervisorChannel: {
        notify: () => {},
        onNotification: () => () => {},
      },
    });

    await layer.start();
    try {
      await Promise.race([
        retryStarted,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("authorization poll was not retried")), 3_000),
        ),
      ]);
      expect(requestCount).toBe(3);
      expect(new Set(publicKeys)).toHaveLength(1);
    } finally {
      await layer.close();
    }
  });

  it("aborts the authorization request before close resolves", async () => {
    let requestCount = 0;
    let authorizationRequestClosed = false;
    let resolveAuthorizationStarted: (() => void) | undefined;
    let resolveAuthorizationClosed: (() => void) | undefined;
    const authorizationStarted = new Promise<void>((resolve) => {
      resolveAuthorizationStarted = resolve;
    });
    const authorizationClosed = new Promise<void>((resolve) => {
      resolveAuthorizationClosed = resolve;
    });
    const server = createServer((request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      resolveAuthorizationStarted?.();
      response.on("close", () => {
        authorizationRequestClosed = true;
        resolveAuthorizationClosed?.();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const layer = createHappyLayer({
      config: {
        machineIdentity: null,
        machineName: "shutdown-test",
        relayUrl: `http://127.0.0.1:${address.port}`,
      },
      source: {},
      supervisorChannel: {
        notify: () => {},
        onNotification: () => () => {},
      },
    });

    await layer.start();
    await authorizationStarted;
    await layer.close();
    await Promise.race([
      authorizationClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("authorization request stayed open")), 500),
      ),
    ]);

    expect(authorizationRequestClosed).toBe(true);
  });
});
