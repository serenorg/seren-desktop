// ABOUTME: Guards the happy@1.2.0 relay-sync patch that stops duplicate prompt
// ABOUTME: ingest and dropped replies. Reads the real installed package, no mocks.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");

function installedClientSource(): string {
  const distDir = join(repoRoot, "node_modules", "happy", "dist");
  const clientFile = readdirSync(distDir).find(
    (name) => name.startsWith("types-") && name.endsWith(".mjs"),
  );
  if (!clientFile) throw new Error("happy dist client bundle not found");
  return readFileSync(join(distDir, clientFile), "utf8");
}

describe("happy relay sync patch", () => {
  const source = installedClientSource();

  it("stays pinned to the happy version the patch was built against", () => {
    const declared = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const version = declared.dependencies.happy;
    // A bump without regenerating the patch silently reverts every fix below.
    expect(workspace).toContain(`happy@${version}: patches/happy@${version}.patch`);
  });

  it("skips relay messages the socket handler already routed", () => {
    // Without this guard an in-flight fetch re-routes messages the socket
    // delivered mid-await, and a phone prompt executes twice on the desktop.
    expect(source).toContain("if (message.seq <= this.lastSeq)");
  });

  it("advances lastSeq before routing so fetch and socket cannot overlap", () => {
    const fetchIndex = source.indexOf("async fetchMessages()");
    const sequenceIndex = source.indexOf("this.lastSeq = message.seq;", fetchIndex);
    const routeIndex = source.indexOf("this.routeIncomingMessage(body);", fetchIndex);
    expect(sequenceIndex).toBeGreaterThan(fetchIndex);
    expect(routeIndex).toBeGreaterThan(sequenceIndex);
  });

  it("does not advance the inbound cursor from outbound POST responses", () => {
    // POST responses may leapfrog an unfetched phone prompt in the shared relay
    // sequence. Only socket/GET observation is allowed to advance lastSeq.
    const flushIndex = source.indexOf("async flushOutbox()");
    const enqueueIndex = source.indexOf("enqueueMessage(content", flushIndex);
    const flushBody = source.slice(flushIndex, enqueueIndex);
    expect(flushBody).not.toContain("this.lastSeq");
    expect(flushBody).not.toContain("response.data.messages");
  });

  it("filters this client's echoed outbound messages from socket and fetch routing", () => {
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
  });

  it("flushes the outbox before stopping the send sync on close", () => {
    const closeIndex = source.indexOf("[API] socket.close() called");
    expect(closeIndex).toBeGreaterThan(-1);
    const closeBody = source.slice(closeIndex, closeIndex + 600);
    const flushIndex = closeBody.indexOf("await this.flushOutbox()");
    const stopIndex = closeBody.indexOf("this.sendSync.stop()");
    expect(flushIndex).toBeGreaterThan(-1);
    // stop() latches a flag that makes a pending flush a no-op, so ordering is
    // the whole fix: flush must complete first or the turn's tail is dropped.
    expect(flushIndex).toBeLessThan(stopIndex);
  });

  it("drains the outbox from the head so batches keep production order", () => {
    const flushIndex = source.indexOf("MAX_OUTBOX_BATCH_SIZE);");
    expect(flushIndex).toBeGreaterThan(-1);
    const flushBody = source.slice(flushIndex, flushIndex + 300);
    expect(flushBody).toContain("const batchStart = 0;");
    expect(flushBody).not.toContain("this.pendingOutbox.length - batchSize");
  });
});
