// ABOUTME: Verifies provider notifications sent before a subscriber attaches are delivered.
// ABOUTME: Runs a real WebSocket server against the real provider-runtime client.

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

// @ts-expect-error — the bridge layer is plain ESM without declarations.
import {
  createProviderRuntimeClient,
  createProviderSource,
  // @ts-expect-error — the bridge layer is plain ESM without declarations.
} from "../../bin/happy-bridge/provider-source.mjs";

type BridgeClient = {
  connect(): Promise<void>;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};

const servers: WebSocketServer[] = [];
const clients: BridgeClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * Answers the handshake and every later RPC, and hands the live socket back so
 * the test can push notifications the way the provider runtime does.
 */
async function startProviderRuntime(
  { rejectMethods = new Set<string>() }: { rejectMethods?: Set<string> } = {},
): Promise<{
  port: number;
  socket: Promise<{ send(data: string): void }>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const socket = new Promise<{ send(data: string): void }>((resolve) => {
    server.once("connection", (connection) => {
      connection.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.id === undefined || message.id === null) return;
        if (rejectMethods.has(message.method)) {
          connection.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32000, message: "synthetic provider rejection" },
            }),
          );
          return;
        }
        connection.send(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }),
        );
      });
      resolve(connection);
    });
  });

  return { port: (server.address() as AddressInfo).port, socket };
}

function connectedClient(port: number): BridgeClient {
  const client = createProviderRuntimeClient({
    providerRuntime: { host: "127.0.0.1", port, token: "test-token" },
  }) as BridgeClient;
  clients.push(client);
  return client;
}

describe("Happy provider notification buffering (#3150)", () => {
  it("distinguishes a confirmed provider rejection from an ambiguous disconnect", async () => {
    const runtime = await startProviderRuntime({
      rejectMethods: new Set(["provider_spawn"]),
    });
    const client = connectedClient(runtime.port);
    await client.connect();

    await expect(client.call("provider_spawn")).rejects.toMatchObject({
      message: "synthetic provider rejection",
      providerRequestRejected: true,
    });
  });

  it("delivers a turn completion that arrived before registration subscribed", async () => {
    // A bridge restart during a live turn seeds the session busy from the
    // list-time snapshot, then spends several relay round trips before
    // subscribing. Dropping what lands in that window left the queue for that
    // session busy forever and the next phone prompt never drained.
    const runtime = await startProviderRuntime();
    const client = connectedClient(runtime.port);
    await client.connect();
    const socket = await runtime.socket;

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "provider://prompt-complete",
        params: { sessionId: "session-a", stopReason: "completed" },
      }),
    );
    // The socket preserves order, so an answered RPC proves the notification
    // above was already handled.
    await client.call("provider_ping");

    const source = createProviderSource({
      client,
      config: { machineName: "buffer-test" },
    }) as { subscribe(onEvent: (event: unknown) => void): () => void };
    const received: Array<{ kind: string; sessionId: string }> = [];
    source.subscribe((event) =>
      received.push(event as { kind: string; sessionId: string }),
    );

    expect(received).toEqual([
      { kind: "turn-complete", sessionId: "session-a", payload: { stopReason: "completed" } },
    ]);
  });

  it("keeps the newest notifications when nothing is subscribed for a long time", async () => {
    const runtime = await startProviderRuntime();
    const client = connectedClient(runtime.port);
    await client.connect();
    const socket = await runtime.socket;

    for (let index = 0; index < 40; index += 1) {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "provider://message-chunk",
          params: { sessionId: "session-a", text: `chunk-${index}` },
        }),
      );
    }
    await client.call("provider_ping");

    const received: Array<{ payload: { text: string } }> = [];
    (
      client as unknown as {
        subscribeNotifications(
          listener: (method: string, params: { text: string }) => void,
        ): () => void;
      }
    ).subscribeNotifications((_method, params) =>
      received.push({ payload: params }),
    );

    // Bounded, and the oldest are the ones dropped: a terminal event is always
    // the most recent thing a stalled session emitted.
    expect(received).toHaveLength(32);
    expect(received[0].payload.text).toBe("chunk-8");
    expect(received[31].payload.text).toBe("chunk-39");
  });

  it("does not evict one session's completion behind restore chatter from other sessions", async () => {
    const runtime = await startProviderRuntime();
    const client = connectedClient(runtime.port);
    await client.connect();
    const socket = await runtime.socket;

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "provider://prompt-complete",
        params: { sessionId: "active-session", stopReason: "completed" },
      }),
    );
    for (let index = 0; index < 40; index += 1) {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "provider://session-status",
          params: { sessionId: `restored-session-${index}`, status: "ready" },
        }),
      );
    }
    await client.call("provider_ping");

    const received: Array<{ kind: string; sessionId: string }> = [];
    const source = createProviderSource({
      client,
      config: { machineName: "buffer-test" },
    }) as { subscribe(onEvent: (event: unknown) => void): () => void };
    source.subscribe((event) => received.push(event as { kind: string; sessionId: string }));

    expect(received).toHaveLength(41);
    expect(received[0]).toMatchObject({
      kind: "turn-complete",
      sessionId: "active-session",
    });
  });
});
