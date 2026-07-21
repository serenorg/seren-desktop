// ABOUTME: Verifies the bridge keeps exactly one supervisor listener across pairing.
// ABOUTME: Drives the real layer and supervisor channel against a local relay.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — the bridge layer is plain ESM without declarations.
import { createHappyLayer } from "../../bin/happy-bridge/happy-layer.mjs";
// @ts-expect-error — the bridge layer is plain ESM without declarations.
import { createSupervisorChannel } from "../../bin/happy-bridge/supervisor-channel.mjs";

type HappyLayer = {
  start(): Promise<unknown>;
  startPairing(): Promise<string>;
  close(): Promise<void>;
};

type SupervisorChannel = {
  handleLine(line: string): void;
  close(): void;
};

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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });
}

/**
 * Stands in for the Happy relay: it answers the request that mints a pairing
 * code and then leaves every authorization poll for that key hanging, which is
 * the state a user sits in while the QR is on screen.
 */
async function startRelay(): Promise<{
  url: string;
  publicKeys: string[];
  pollsClosed: number;
  pollStarted: Promise<void>;
}> {
  const publicKeys: string[] = [];
  const seen = new Map<string, number>();
  const state = { pollsClosed: 0 };
  let resolvePollStarted: (() => void) | undefined;
  const pollStarted = new Promise<void>((resolve) => {
    resolvePollStarted = resolve;
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void readBody(request).then((body) => {
      const publicKey = String(JSON.parse(body).publicKey);
      const count = (seen.get(publicKey) ?? 0) + 1;
      seen.set(publicKey, count);
      if (count === 1) {
        publicKeys.push(publicKey);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      resolvePollStarted?.();
      response.on("close", () => {
        state.pollsClosed += 1;
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    publicKeys,
    get pollsClosed() {
      return state.pollsClosed;
    },
    pollStarted,
  };
}

function createLayer(
  relayUrl: string,
  channel: SupervisorChannel,
  onShutdownRequest: () => Promise<void>,
): HappyLayer {
  return createHappyLayer({
    config: {
      machineIdentity: null,
      machineName: "supervisor-listener-test",
      relayUrl,
    },
    source: {},
    supervisorChannel: channel,
    onShutdownRequest,
  }) as HappyLayer;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("Happy supervisor listener lifetime (#3153)", () => {
  it("detaches its supervisor listener when the layer closes", async () => {
    // `subscribeToSupervisor` returned nothing, so every call site stored
    // `undefined` and the listener it registered could never be removed. The
    // handle is only observable through the teardown it is supposed to perform.
    const relay = await startRelay();
    const channel = createSupervisorChannel({ write: () => {} }) as SupervisorChannel;
    let shutdownRequests = 0;
    const layer = createLayer(relay.url, channel, async () => {
      shutdownRequests += 1;
    });

    await layer.start();
    await relay.pollStarted;
    await layer.close();

    channel.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "shutdown" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(shutdownRequests).toBe(0);
  });

  it("still handles cancel_pairing while the pairing wait is in flight", async () => {
    // The listener has to stay attached across pairing: `cancel_pairing` is the
    // one notification that only ever arrives during it. Unsubscribing before
    // `startPairing` would queue it until pairing succeeded — never, for a user
    // who is cancelling.
    const relay = await startRelay();
    const channel = createSupervisorChannel({ write: () => {} }) as SupervisorChannel;
    const layer = createLayer(relay.url, channel, async () => {});

    await layer.start();
    await relay.pollStarted;
    expect(relay.pollsClosed).toBe(0);

    channel.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "cancel_pairing" }));

    await waitFor(() => relay.pollsClosed > 0, "the abandoned authorization poll to close");
    await layer.close();
  });
});

describe("Happy pairing attempt ownership (#3153)", () => {
  it("keeps the live attempt when an abandoned one settles", async () => {
    // Attempt #1's rejection nulled the shared slot unconditionally, so a third
    // `startPairing` minted a third keypair while attempt #2 was still polling,
    // leaving two authorization loops live at once.
    const relay = await startRelay();
    const channel = createSupervisorChannel({ write: () => {} }) as SupervisorChannel;
    const layer = createLayer(relay.url, channel, async () => {});

    await layer.start();
    await relay.pollStarted;
    expect(relay.publicKeys).toHaveLength(1);

    // Dismiss and re-pair without yielding, which is what a user clicking
    // straight through does: attempt #2 claims the slot before attempt #1's
    // aborted request has reached its rejection handler.
    channel.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "cancel_pairing" }));
    await layer.startPairing();
    expect(relay.publicKeys).toHaveLength(2);

    // Now let attempt #1 settle, with #2 live and still polling.
    await waitFor(() => relay.pollsClosed > 0, "attempt #1's poll to be abandoned");
    await new Promise((resolve) => setTimeout(resolve, 150));

    await layer.startPairing();
    expect(relay.publicKeys).toHaveLength(2);

    await layer.close();
  });
});
