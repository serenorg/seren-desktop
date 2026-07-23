// ABOUTME: Guards the happy@1.2.0 relay-sync patch that stops duplicate prompt
// ABOUTME: ingest and dropped replies. Reads the real installed package, no mocks.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");

function installedClientSources(): Array<{ name: string; source: string }> {
  const distDir = join(repoRoot, "node_modules", "happy", "dist");
  const clientFiles = readdirSync(distDir).filter(
    (name) => name.startsWith("types-") && /\.(?:cjs|mjs)$/.test(name),
  );
  if (clientFiles.length !== 2) {
    throw new Error("happy ESM and CommonJS client bundles not found");
  }
  return clientFiles.map((name) => ({
    name,
    source: readFileSync(join(distDir, name), "utf8"),
  }));
}

type InvalidateSyncConstructor = new (command: () => Promise<void>) => {
  invalidate: () => void;
  invalidateAndAwait: () => Promise<void>;
  stop: () => void;
};

function loadInstalledInvalidateSync(source: string): InvalidateSyncConstructor {
  const classStart = source.indexOf("class InvalidateSync {");
  const classEnd = source.indexOf("\n\nfunction isRecord", classStart);
  if (classStart < 0 || classEnd < 0) {
    throw new Error("Happy InvalidateSync implementation not found");
  }
  const classSource = source.slice(classStart, classEnd);
  const evaluate = new Function(
    "backoff",
    `${classSource}\nreturn InvalidateSync;`,
  ) as (backoff: (command: () => Promise<void>) => Promise<void>) => InvalidateSyncConstructor;
  return evaluate(async (command) => command());
}

describe("happy relay sync patch", () => {
  const sources = installedClientSources();

  it("stays pinned to the happy version the patch was built against", () => {
    const declared = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const version = declared.dependencies.happy;
    // A bump without regenerating the patch silently reverts every fix below.
    expect(workspace).toContain(`happy@${version}: patches/happy@${version}.patch`);
  });

  it("lets the bridge supply a stable data-key session encryption key", () => {
    for (const { source } of sources) {
      const createStart = source.indexOf("async getOrCreateSession(opts)");
      const createEnd = source.indexOf("async getOrCreateMachine(opts)", createStart);
      const createBody = source.slice(createStart, createEnd);
      expect(createBody).toContain(
        "opts.encryptionKey ? new Uint8Array(opts.encryptionKey) : getRandomBytes(32)",
      );
      expect(createBody).toContain('throw new Error("Session encryption key must be 32 bytes")');
    }
  });

  it("sets a validated resume cursor before the session socket connects", () => {
    for (const { source } of sources) {
      const constructorStart = source.indexOf("constructor(token, session, options = {})");
      const socketConnect = source.indexOf("this.socket.connect();", constructorStart);
      const cursorAssignment = source.indexOf("this.lastSeq = resumeFromSeq;", constructorStart);
      expect(constructorStart).toBeGreaterThan(-1);
      expect(cursorAssignment).toBeGreaterThan(constructorStart);
      expect(cursorAssignment).toBeLessThan(socketConnect);
      expect(source).toContain(
        'throw new Error("Session resume sequence must be a non-negative safe integer")',
      );
      expect(source).toContain("sessionSyncClient(session, options)");
    }
  });

  it("skips relay messages the socket handler already routed", () => {
    // Without this guard an in-flight fetch re-routes messages the socket
    // delivered mid-await, and a phone prompt executes twice on the desktop.
    for (const { source } of sources) {
      expect(source).toContain("if (message.seq <= this.lastSeq)");
    }
  });

  it("advances lastSeq before routing so fetch and socket cannot overlap", () => {
    for (const { source } of sources) {
      const fetchIndex = source.indexOf("async fetchMessages()");
      const sequenceIndex = source.indexOf("this.lastSeq = message.seq;", fetchIndex);
      const routeIndex = source.indexOf("this.routeIncomingMessage(body);", fetchIndex);
      expect(sequenceIndex).toBeGreaterThan(fetchIndex);
      expect(routeIndex).toBeGreaterThan(sequenceIndex);
    }
  });

  it("does not advance the inbound cursor from outbound POST responses", () => {
    // POST responses may leapfrog an unfetched phone prompt in the shared relay
    // sequence. Only socket/GET observation is allowed to advance lastSeq.
    for (const { source } of sources) {
      const flushIndex = source.indexOf("async flushOutbox()");
      const enqueueIndex = source.indexOf("enqueueMessage(content", flushIndex);
      const flushBody = source.slice(flushIndex, enqueueIndex);
      expect(flushBody).not.toContain("this.lastSeq");
      expect(flushBody).not.toContain("response.data.messages");
    }
  });

  it("filters this client's echoed outbound messages from socket and fetch routing", () => {
    for (const { source } of sources) {
      expect(source).toContain("this.outboundMessageLocalIds.add(localId);");

      const socketStart = source.indexOf('if (data.body.t === "new-message")');
      const socketEnd = source.indexOf('data.body.t === "update-session"', socketStart);
      const socketBody = source.slice(socketStart, socketEnd);
      const socketAdvance = socketBody.indexOf("this.lastSeq = messageSeq;");
      const socketFilter = socketBody.indexOf(
        "this.outboundMessageLocalIds.delete(message.localId)",
      );
      expect(socketAdvance).toBeGreaterThan(-1);
      expect(socketFilter).toBeGreaterThan(socketAdvance);

      const fetchStart = source.indexOf("async fetchMessages()");
      const fetchEnd = source.indexOf("async flushOutbox()", fetchStart);
      const fetchBody = source.slice(fetchStart, fetchEnd);
      const fetchAdvance = fetchBody.indexOf("this.lastSeq = message.seq;");
      const fetchFilter = fetchBody.indexOf(
        "this.outboundMessageLocalIds.delete(message.localId)",
      );
      expect(fetchAdvance).toBeGreaterThan(-1);
      expect(fetchFilter).toBeGreaterThan(fetchAdvance);
    }
  });

  it("joins the single-flight outbox drain before stopping send sync on close", () => {
    for (const { source } of sources) {
      const closeIndex = source.indexOf("[API] socket.close() called");
      expect(closeIndex).toBeGreaterThan(-1);
      const closeBody = source.slice(closeIndex, closeIndex + 600);
      const flushIndex = closeBody.indexOf("await this.sendSync.invalidateAndAwait()");
      const stopIndex = closeBody.indexOf("this.sendSync.stop()");
      expect(flushIndex).toBeGreaterThan(-1);
      expect(flushIndex).toBeLessThan(stopIndex);
      expect(closeBody).not.toContain("await this.flushOutbox()");
    }
  });

  it("serializes close behind a delayed relay drain without losing or duplicating messages", async () => {
    for (const { source } of sources) {
      const InvalidateSync = loadInstalledInvalidateSync(source);
      const outbox = ["first"];
      const postedBatches: string[][] = [];
      let activeDrains = 0;
      let maxActiveDrains = 0;
      let releaseFirstPost: (() => void) | undefined;
      const firstPostBlocked = new Promise<void>((resolve) => {
        releaseFirstPost = resolve;
      });

      const sync = new InvalidateSync(async () => {
        activeDrains += 1;
        maxActiveDrains = Math.max(maxActiveDrains, activeDrains);
        try {
          const batch = outbox.slice();
          if (batch.length === 0) return;
          postedBatches.push(batch);
          if (postedBatches.length === 1) {
            await firstPostBlocked;
          }
          outbox.splice(0, batch.length);
        } finally {
          activeDrains -= 1;
        }
      });

      sync.invalidate();
      outbox.push("second");
      const closeDrain = sync.invalidateAndAwait();
      releaseFirstPost?.();
      await closeDrain;
      sync.stop();

      expect(postedBatches).toEqual([["first"], ["second"]]);
      expect(maxActiveDrains).toBe(1);
      expect(outbox).toEqual([]);
    }
  });

  it("drains the outbox from the head so batches keep production order", () => {
    for (const { source } of sources) {
      const flushIndex = source.indexOf("MAX_OUTBOX_BATCH_SIZE);");
      expect(flushIndex).toBeGreaterThan(-1);
      const flushBody = source.slice(flushIndex, flushIndex + 300);
      expect(flushBody).toContain("const batchStart = 0;");
      expect(flushBody).not.toContain("this.pendingOutbox.length - batchSize");
    }
  });

  it("copies the patched Happy dist into the isolated production bundle", () => {
    const buildScript = readFileSync(
      join(repoRoot, "scripts", "build-provider-runtime.ts"),
      "utf8",
    );
    const isolatedInstall = buildScript.indexOf('"--ignore-workspace"');
    const patchedDistCopy = buildScript.indexOf(
      "cpSync(workspaceHappyDist, bundledHappyDist",
    );
    expect(isolatedInstall).toBeGreaterThan(-1);
    expect(patchedDistCopy).toBeGreaterThan(isolatedInstall);
  });
});
