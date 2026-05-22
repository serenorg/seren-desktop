// ABOUTME: Source-level regression test for #1997 — Seren Chat queued
// ABOUTME: messages must drain strictly serially with no loading=false gap.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatContentSource = readFileSync(
  resolve("src/components/chat/ChatContent.tsx"),
  "utf-8",
);

function indexOrThrow(source: string, anchor: string): number {
  const i = source.indexOf(anchor);
  if (i < 0) {
    throw new Error(
      `anchor not found in source: ${JSON.stringify(anchor)}. ` +
        `If the source was renamed, update this test's anchor — silent miss ` +
        `would mask a real regression like #1997.`,
    );
  }
  return i;
}

function sliceFunction(source: string, openAnchor: string): string {
  // Grab a generous window starting at the function's first line. 200 lines
  // is comfortably larger than sendMessageImmediate's body and still small
  // enough that we won't accidentally match unrelated downstream code.
  const start = indexOrThrow(source, openAnchor);
  return source.slice(start).split("\n").slice(0, 200).join("\n");
}

describe("#1997 — queued messages drain strictly serially in Seren Chat", () => {
  it("sendMessageImmediate sets loading=true synchronously before any await", () => {
    const body = sliceFunction(
      chatContentSource,
      "const sendMessageImmediate = async (",
    );

    const setLoadingIdx = body.indexOf("conversationStore.setLoading(true, id)");
    const firstAwaitIdx = body.indexOf("await ");
    const addMessageIdx = body.indexOf(
      "conversationStore.addMessage(userMessage, id)",
    );

    expect(
      setLoadingIdx,
      "setLoading(true, id) must be called early so the persistMessage yield " +
        "does not expose a loading=false gap to concurrent submissions (#1997)",
    ).toBeGreaterThanOrEqual(0);
    expect(setLoadingIdx).toBeLessThan(firstAwaitIdx);
    expect(setLoadingIdx).toBeLessThan(addMessageIdx);
  });

  it("the drain block awaits the recursive sendMessageImmediate, not setTimeout", () => {
    const body = sliceFunction(
      chatContentSource,
      "const sendMessageImmediate = async (",
    );

    // The drain tail must contain an awaited recursive call.
    expect(body).toContain("await sendMessageImmediate(nextMessage)");

    // And must NOT contain the old fire-and-forget setTimeout pattern that
    // created a 100ms loading=false gap and offered no serialization
    // guarantee against concurrent submissions.
    expect(body).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{[^}]*sendMessageImmediate\(/s);
  });

  it("the drain pops exactly one message per cycle and survives thread switch", () => {
    const body = sliceFunction(
      chatContentSource,
      "const sendMessageImmediate = async (",
    );

    // Single-message pop: [head, ...rest] = queue is the canonical shape.
    expect(body).toContain("const [nextMessage, ...remainingQueue] = queue;");
    expect(body).toContain("setMessageQueue(remainingQueue);");

    // Thread-switch guard still wraps the recursive call so a mid-drain
    // thread switch aborts the chain cleanly instead of sending the next
    // queued message into the wrong conversation.
    expect(body).toContain("if (conversationId() === drainConversationId)");
    expect(body).toContain(
      "Skipping queued message — conversation changed",
    );
  });
});
