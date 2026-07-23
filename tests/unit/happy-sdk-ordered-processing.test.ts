// ABOUTME: Exercises Happy's opt-in durable inbound sequencing through the real installed SDK.
// ABOUTME: Uses a local relay only; socket/fetch ordering, callbacks, and checkpoints are not mocked.

import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiSessionClient, configuration } from "happy/lib";

// @ts-expect-error — the bridge key store is plain ESM without declarations.
import { createHappySessionKeyStore } from "../../bin/happy-bridge/session-key-store.mjs";

type RelayMessage = {
  seq: number;
  localId: string;
  content: { t: string; c?: string };
};

type ClientInternals = {
  fetchMessages(): Promise<void>;
  lastSeq: number;
  lastProcessedSeq: number;
  inboundFailed: boolean;
  pendingMessages: Array<{ seq?: number; data?: unknown } | unknown>;
  pendingFileEvents: Array<{ seq?: number; data?: unknown } | unknown>;
  outboundMessageLocalIds: Set<string>;
  socket: {
    listeners(event: string): Array<(data: unknown) => void>;
  };
};

const originalServerUrl = configuration.serverUrl;
const require = createRequire(import.meta.url);
const commonJsHappy = require("happy/lib") as typeof import("happy/lib");
const originalCommonJsServerUrl = commonJsHappy.configuration.serverUrl;
const mutableConfiguration = configuration as unknown as { serverUrl: string };
const mutableCommonJsConfiguration = commonJsHappy.configuration as unknown as {
  serverUrl: string;
};
const servers = new Set<ReturnType<typeof createServer>>();
const clients = new Set<ApiSessionClient>();
const temporaryDirectories = new Set<string>();
const dataKey = new Uint8Array(32).fill(0x29);

afterEach(async () => {
  await Promise.allSettled([...clients].map((client) => client.close()));
  clients.clear();
  mutableConfiguration.serverUrl = originalServerUrl;
  mutableCommonJsConfiguration.serverUrl = originalCommonJsServerUrl;
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  servers.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function encryptMessage(value: unknown): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([0]), nonce, encrypted, cipher.getAuthTag()]).toString(
    "base64",
  );
}

function encryptedRecord(seq: number, value: unknown, localId = `remote-${seq}`): RelayMessage {
  return {
    seq,
    localId,
    content: { t: "encrypted", c: encryptMessage(value) },
  };
}

function userRecord(seq: number, text: string): RelayMessage {
  return encryptedRecord(seq, {
    role: "user",
    content: { type: "text", text },
  });
}

function fileRecord(seq: number): RelayMessage {
  return encryptedRecord(seq, {
    role: "session",
    content: {
      type: "session",
      data: {
        id: `file-event-${seq}`,
        time: seq,
        role: "user",
        ev: {
          t: "file",
          ref: `file-ref-${seq}`,
          name: "asset.txt",
          size: 12,
          mimeType: "text/plain",
        },
      },
    },
  });
}

async function startRelay(messages: RelayMessage[]): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || !url.pathname.endsWith("/messages")) {
      response.writeHead(404).end();
      return;
    }
    const afterSeq = Number(url.searchParams.get("after_seq") ?? 0);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        messages: messages.filter((message) => message.seq > afterSeq),
        hasMore: false,
      }),
    );
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function createClient(
  resumeFromSeq: number,
  onMessageProcessed?: (seq: number) => void | Promise<void>,
  inboundCloseTimeoutMs?: number,
): ApiSessionClient {
  const client = new ApiSessionClient(
    "synthetic-token",
    {
      id: "synthetic-ordered-session",
      seq: resumeFromSeq,
      metadata: { path: "/synthetic/project", host: "synthetic-host" },
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 1,
      encryptionKey: dataKey,
      encryptionVariant: "dataKey",
    } as never,
    { resumeFromSeq, onMessageProcessed, inboundCloseTimeoutMs },
  );
  clients.add(client);
  return client;
}

async function createReadyCursorStore(sessionId: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "seren-happy-close-drain-"));
  temporaryDirectories.add(directory);
  const machineKey = Buffer.alloc(32, 0x62);
  const store = createHappySessionKeyStore({ directory, machineKey });
  await store.getOrCreate(sessionId, `seren-${sessionId}`);
  await store.markReady(sessionId, "synthetic-relay-row");
  return { directory, machineKey, store };
}

async function closeClient(client: ApiSessionClient): Promise<void> {
  clients.delete(client);
  await client.close();
}

function internals(client: ApiSessionClient): ClientInternals {
  return client as unknown as ClientInternals;
}

function processingFailure(client: ApiSessionClient): Promise<Error> {
  return new Promise((resolve) => {
    client.once("inboundProcessingError", resolve);
  });
}

describe("installed Happy ordered inbound processing patch", () => {
  it("durably latches an archive update received before a consumer registers its listener", async () => {
    mutableConfiguration.serverUrl = await startRelay([]);
    const client = createClient(0);
    const state = internals(client);
    const socketUpdate = state.socket.listeners("update")[0];
    expect(socketUpdate).toBeTypeOf("function");

    socketUpdate({
      body: {
        t: "update-session",
        metadata: {
          version: 2,
          value: encryptMessage({
            path: "/synthetic/project",
            host: "synthetic-host",
            lifecycleState: "archiveRequested",
          }),
        },
      },
    });

    expect(client.hasArchiveSignal()).toBe(true);
    let lateListenerCalls = 0;
    client.on("archived", () => {
      lateListenerCalls += 1;
    });
    expect(lateListenerCalls).toBe(0);
    await closeClient(client);
  });

  it("serializes user, file, generic, no-op, and echo records before exact checkpoints", async () => {
    const messages = [
      userRecord(8, "first"),
      fileRecord(9),
      encryptedRecord(10, { role: "assistant", content: { type: "text", text: "generic" } }),
      { seq: 11, localId: "plain-no-op", content: { t: "unsupported" } },
      encryptedRecord(12, { role: "assistant", content: { type: "text", text: "echo" } }, "own-echo"),
      userRecord(13, "second"),
    ];
    mutableConfiguration.serverUrl = await startRelay(messages);
    const firstCallbackGate = defer();
    const firstCheckpointGate = defer();
    const genericHandlerGate = defer();
    const events: string[] = [];
    const client = createClient(7, async (seq) => {
      if (seq === 8) {
        events.push("checkpoint:8:start");
        await firstCheckpointGate.promise;
        events.push("checkpoint:8:end");
        return;
      }
      events.push(`checkpoint:${seq}`);
    });
    const state = internals(client);
    state.outboundMessageLocalIds.add("own-echo");
    client.on("message", async () => {
      events.push("generic:start");
      await genericHandlerGate.promise;
      events.push("generic:end");
    });

    await state.fetchMessages();

    expect(state.lastSeq).toBe(13);
    expect(state.lastProcessedSeq).toBe(7);
    expect(state.pendingMessages).toHaveLength(1);
    expect(state.pendingMessages[0]).toMatchObject({ seq: 8 });

    client.onUserMessage(async (message) => {
      events.push(`user:${message.content.text}:start`);
      if (message.content.text === "first") await firstCallbackGate.promise;
      events.push(`user:${message.content.text}:end`);
    });
    await waitFor(() => events.includes("user:first:start"), "first user callback");
    expect(events).toEqual(["user:first:start"]);

    firstCallbackGate.resolve();
    await waitFor(() => events.includes("checkpoint:8:start"), "first checkpoint");
    expect(state.pendingFileEvents).toHaveLength(0);

    firstCheckpointGate.resolve();
    await waitFor(() => state.pendingFileEvents.length === 1, "buffered file event");
    expect(state.pendingFileEvents[0]).toMatchObject({ seq: 9 });

    client.onFileEvent(async (message) => {
      events.push(`file:${message.content.data.ev.name}`);
    });
    await waitFor(() => events.includes("generic:start"), "generic message handler");
    expect(state.lastProcessedSeq).toBe(9);

    genericHandlerGate.resolve();
    await waitFor(() => state.lastProcessedSeq === 13, "all ordered checkpoints");

    expect(events).toEqual([
      "user:first:start",
      "user:first:end",
      "checkpoint:8:start",
      "checkpoint:8:end",
      "file:asset.txt",
      "checkpoint:9",
      "generic:start",
      "generic:end",
      "checkpoint:10",
      "checkpoint:11",
      "checkpoint:12",
      "user:second:start",
      "user:second:end",
      "checkpoint:13",
    ]);
    await closeClient(client);
  });

  it("preserves the SDK's fire-and-forget buffering when the hook is omitted", async () => {
    mutableConfiguration.serverUrl = await startRelay([
      userRecord(1, "first"),
      userRecord(2, "second"),
    ]);
    const client = createClient(0);
    const state = internals(client);

    await state.fetchMessages();

    expect(state.lastSeq).toBe(2);
    expect(state.pendingMessages).toHaveLength(2);
    expect(state.pendingMessages[0]).toMatchObject({
      content: { type: "text", text: "first" },
    });
    expect(state.pendingMessages[0]).not.toHaveProperty("seq");

    const observed: string[] = [];
    client.onUserMessage((message) => {
      observed.push(message.content.text);
    });
    expect(observed).toEqual(["first", "second"]);
    await closeClient(client);
  });

  it("deduplicates a socket record from fetch while preserving one ordered chain", async () => {
    const first = userRecord(1, "socket");
    const second = userRecord(2, "fetch");
    mutableConfiguration.serverUrl = await startRelay([first, second]);
    const callbackGate = defer();
    const events: string[] = [];
    const client = createClient(0, (seq) => {
      events.push(`checkpoint:${seq}`);
    });
    const state = internals(client);
    client.onUserMessage(async (message) => {
      events.push(`user:${message.content.text}`);
      if (message.content.text === "socket") await callbackGate.promise;
    });
    const socketUpdate = state.socket.listeners("update")[0];
    expect(socketUpdate).toBeTypeOf("function");

    socketUpdate({ body: { t: "new-message", message: first } });
    await waitFor(() => events.includes("user:socket"), "socket callback");
    await state.fetchMessages();

    expect(state.lastSeq).toBe(2);
    expect(events).toEqual(["user:socket"]);

    callbackGate.resolve();
    await waitFor(() => state.lastProcessedSeq === 2, "socket/fetch checkpoints");
    expect(events).toEqual([
      "user:socket",
      "checkpoint:1",
      "user:fetch",
      "checkpoint:2",
    ]);
    await closeClient(client);
  });

  it("exposes the same ordered callback contract from the CommonJS bundle", async () => {
    mutableCommonJsConfiguration.serverUrl = await startRelay([userRecord(1, "commonjs")]);
    const checkpoints: number[] = [];
    const handled: string[] = [];
    const client = new commonJsHappy.ApiSessionClient(
      "synthetic-token",
      {
        id: "synthetic-commonjs-session",
        seq: 0,
        metadata: { path: "/synthetic/project", host: "synthetic-host" },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        encryptionKey: dataKey,
        encryptionVariant: "dataKey",
      } as never,
      {
        resumeFromSeq: 0,
        onMessageProcessed: async (seq) => {
          checkpoints.push(seq);
        },
      },
    );
    clients.add(client);
    client.onUserMessage(async (message) => {
      handled.push(message.content.text);
    });

    await internals(client).fetchMessages();
    await waitFor(() => checkpoints.length === 1, "CommonJS checkpoint");

    expect(handled).toEqual(["commonjs"]);
    expect(checkpoints).toEqual([1]);
    await closeClient(client);
  });

  it.each(["handler", "checkpoint"] as const)(
    "poisons later records when the %s rejects",
    async (failurePoint) => {
      mutableConfiguration.serverUrl = await startRelay([
        userRecord(1, "first"),
        userRecord(2, "second"),
      ]);
      const checkpoints: number[] = [];
      const client = createClient(0, async (seq) => {
        if (failurePoint === "checkpoint" && seq === 1) throw new Error("checkpoint rejected");
        checkpoints.push(seq);
      });
      const state = internals(client);
      const failure = processingFailure(client);
      const handled: string[] = [];
      client.onUserMessage(async (message) => {
        handled.push(message.content.text);
        if (failurePoint === "handler") throw new Error("handler rejected");
      });

      await state.fetchMessages();
      expect((await failure).message).toContain(`${failurePoint} rejected`);

      expect(state.lastSeq).toBe(2);
      expect(state.lastProcessedSeq).toBe(0);
      expect(state.inboundFailed).toBe(true);
      expect(handled).toEqual(["first"]);
      expect(checkpoints).toEqual([]);
      await closeClient(client);
    },
  );

  it("poisons later records when an async generic message listener rejects", async () => {
    mutableConfiguration.serverUrl = await startRelay([
      encryptedRecord(1, {
        role: "assistant",
        content: { type: "text", text: "generic" },
      }),
      userRecord(2, "blocked"),
    ]);
    const checkpoints: number[] = [];
    const client = createClient(0, (seq) => {
      checkpoints.push(seq);
    });
    const state = internals(client);
    const failure = processingFailure(client);
    const handled: string[] = [];
    client.on("message", async () => {
      throw new Error("generic listener rejected");
    });
    client.onUserMessage(async (message) => {
      handled.push(message.content.text);
    });

    await state.fetchMessages();
    expect((await failure).message).toContain("generic listener rejected");

    expect(state.lastSeq).toBe(2);
    expect(state.lastProcessedSeq).toBe(0);
    expect(state.inboundFailed).toBe(true);
    expect(handled).toEqual([]);
    expect(checkpoints).toEqual([]);
    await closeClient(client);
  });

  it.each([
    {
      name: "gap",
      messages: [userRecord(1, "blocked"), userRecord(3, "gap")],
      expected: /sequence gap/,
      observedSeq: 1,
    },
    {
      name: "unsafe sequence",
      messages: [
        {
          seq: Number.MAX_SAFE_INTEGER + 1,
          localId: "unsafe",
          content: { t: "unsupported" },
        },
      ],
      expected: /non-negative safe integer/,
      observedSeq: 0,
    },
  ])("fails closed on an exact-sequence $name", async ({ messages, expected, observedSeq }) => {
    mutableConfiguration.serverUrl = await startRelay(messages);
    const checkpoints: number[] = [];
    const client = createClient(0, (seq) => {
      checkpoints.push(seq);
    });
    const state = internals(client);
    const failure = processingFailure(client);

    await state.fetchMessages();
    expect((await failure).message).toMatch(expected);

    expect(state.lastSeq).toBe(observedSeq);
    expect(state.lastProcessedSeq).toBe(0);
    expect(checkpoints).toEqual([]);
    await closeClient(client);
  });

  it("durably checkpoints an accepted blocked head before overflow poisons its queued tail", async () => {
    const messages: RelayMessage[] = [userRecord(1, "blocked")];
    for (let seq = 2; seq <= 257; seq += 1) {
      messages.push({ seq, localId: `plain-${seq}`, content: { t: "unsupported" } });
    }
    mutableConfiguration.serverUrl = await startRelay(messages);
    const providerSessionId = "synthetic-provider-overflow-head";
    const { directory, machineKey, store } =
      await createReadyCursorStore(providerSessionId);
    const providerAcceptanceGate = defer();
    const handlerStarted = defer();
    const checkpoints: number[] = [];
    const client = createClient(0, async (seq) => {
      checkpoints.push(seq);
      await store.markProcessedThroughSeq(providerSessionId, seq);
    });
    const state = internals(client);
    let failureSettled = false;
    const failure = processingFailure(client).then((error) => {
      failureSettled = true;
      return error;
    });
    const handled: string[] = [];
    client.onUserMessage(async (message) => {
      handled.push(message.content.text);
      handlerStarted.resolve();
      await providerAcceptanceGate.promise;
    });

    await state.fetchMessages();
    await handlerStarted.promise;

    expect(state.lastSeq).toBe(256);
    expect(state.lastProcessedSeq).toBe(0);
    expect(state.inboundFailed).toBe(false);
    expect(state.pendingMessages).toHaveLength(0);
    expect(checkpoints).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failureSettled).toBe(false);

    providerAcceptanceGate.resolve();
    expect((await failure).message).toMatch(/queue is full/);

    expect(state.lastProcessedSeq).toBe(1);
    expect(state.inboundFailed).toBe(true);
    expect(handled).toEqual(["blocked"]);
    expect(checkpoints).toEqual([1]);
    expect(
      await createHappySessionKeyStore({ directory, machineKey }).getOrCreate(
        providerSessionId,
        "ignored",
      ),
    ).toMatchObject({ processedThroughSeq: 1 });
    await closeClient(client);
  });

  it("joins an accepted handler and its durable cursor write before close resolves", async () => {
    mutableConfiguration.serverUrl = await startRelay([userRecord(1, "accepted")]);
    const providerSessionId = "synthetic-provider-close-join";
    const { directory, machineKey, store } =
      await createReadyCursorStore(providerSessionId);
    const handlerGate = defer();
    const checkpointStarted = defer();
    const checkpointGate = defer();
    const client = createClient(0, async (seq) => {
      checkpointStarted.resolve();
      await checkpointGate.promise;
      const persisted = await store.markProcessedThroughSeq(providerSessionId, seq);
      expect(persisted.processedThroughSeq).toBe(seq);
    });
    const state = internals(client);
    const handlerStarted = defer();
    client.onUserMessage(async () => {
      handlerStarted.resolve();
      await handlerGate.promise;
    });

    await state.fetchMessages();
    await handlerStarted.promise;

    let closeSettled = false;
    const closing = closeClient(client).then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeSettled).toBe(false);

    handlerGate.resolve();
    await checkpointStarted.promise;
    expect(closeSettled).toBe(false);
    expect(
      await createHappySessionKeyStore({ directory, machineKey }).getOrCreate(
        providerSessionId,
        "ignored",
      ),
    ).toMatchObject({ processedThroughSeq: 0 });

    checkpointGate.resolve();
    await closing;

    expect(
      await createHappySessionKeyStore({ directory, machineKey }).getOrCreate(
        providerSessionId,
        "ignored",
      ),
    ).toMatchObject({ processedThroughSeq: 1 });
    expect(state.lastProcessedSeq).toBe(1);
  });

  it("bounds close without checkpointing a prompt whose handler never accepted it", async () => {
    mutableConfiguration.serverUrl = await startRelay([userRecord(1, "unaccepted")]);
    const providerSessionId = "synthetic-provider-close-timeout";
    const { directory, machineKey, store } =
      await createReadyCursorStore(providerSessionId);
    const handlerGate = defer();
    const checkpoints: number[] = [];
    const client = createClient(
      0,
      async (seq) => {
        checkpoints.push(seq);
        await store.markProcessedThroughSeq(providerSessionId, seq);
      },
      40,
    );
    const state = internals(client);
    const handlerStarted = defer();
    client.onUserMessage(async () => {
      handlerStarted.resolve();
      await handlerGate.promise;
    });

    await state.fetchMessages();
    await handlerStarted.promise;

    const startedAt = Date.now();
    await expect(closeClient(client)).rejects.toThrow(
      "Timed out draining relay input after 40ms",
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(state.lastProcessedSeq).toBe(0);
    expect(checkpoints).toEqual([]);
    expect(
      await createHappySessionKeyStore({ directory, machineKey }).getOrCreate(
        providerSessionId,
        "ignored",
      ),
    ).toMatchObject({ processedThroughSeq: 0 });

    handlerGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.lastProcessedSeq).toBe(0);
    expect(checkpoints).toEqual([]);
    expect(
      await createHappySessionKeyStore({ directory, machineKey }).getOrCreate(
        providerSessionId,
        "ignored",
      ),
    ).toMatchObject({ processedThroughSeq: 0 });
  });
});
