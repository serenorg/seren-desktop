// ABOUTME: Source-level regression test for #1996 — Seren Chat drafts must
// ABOUTME: survive cross-mount thread switches (pane keyed by thread:${id}).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatContentSource = readFileSync(
  resolve("src/components/chat/ChatContent.tsx"),
  "utf-8",
);
const threadContentSource = readFileSync(
  resolve("src/components/layout/ThreadContent.tsx"),
  "utf-8",
);

function indexOrThrow(source: string, anchor: string): number {
  const i = source.indexOf(anchor);
  if (i < 0) {
    throw new Error(
      `anchor not found in source: ${JSON.stringify(anchor)}. ` +
        `If the source was renamed, update this test's anchor — silent miss ` +
        `would mask a real regression like #1996.`,
    );
  }
  return i;
}

describe("#1996 — chat draft persists across pane remounts on thread switch", () => {
  it("ThreadContent still keys panes by thread, which forces unmount on switch", () => {
    // This is the precondition that makes the bug possible. If the parent
    // ever stops keying on the thread id, the createEffect alone is enough
    // and the onCleanup write below becomes belt-and-suspenders. Locking
    // the precondition here makes the why-we-need-onCleanup story
    // self-documenting in the test suite.
    expect(threadContentSource).toContain("`thread:${window.threadId}`");
  });

  it("ChatContent declares the module-scoped chatDrafts Map (write target)", () => {
    expect(chatContentSource).toContain(
      "const chatDrafts = new Map<string, string>();",
    );
  });

  it("ChatContent saves the current draft on unmount via onCleanup", () => {
    // The fix: onCleanup runs before SolidJS tears the component down,
    // so we capture the draft before the parent's keyed <For> unmounts us.
    // Without this write path, the in-effect save branch never fires when
    // ThreadContent rekeys the pane, and the draft is lost.
    const onCleanupIdx = indexOrThrow(chatContentSource, "onCleanup(() => {");
    const draftsMapIdx = indexOrThrow(
      chatContentSource,
      "const chatDrafts = new Map<string, string>();",
    );

    // Slice from each onCleanup occurrence forward and find one that
    // writes to chatDrafts. There are several onCleanup blocks in the
    // file (markdown worker terminate, etc.) — we want the one that
    // closes the draft persistence loop.
    let found = false;
    let cursor = onCleanupIdx;
    while (cursor !== -1) {
      const block = chatContentSource.slice(cursor, cursor + 400);
      if (
        block.includes("chatDrafts.set(") &&
        block.includes("chatDrafts.delete(")
      ) {
        found = true;
        break;
      }
      cursor = chatContentSource.indexOf("onCleanup(() => {", cursor + 1);
    }

    expect(
      found,
      "an onCleanup block must write to chatDrafts so cross-mount switches " +
        "do not lose the draft (#1996)",
    ).toBe(true);
    expect(onCleanupIdx).toBeGreaterThan(draftsMapIdx);
  });

  it("ChatContent keeps the in-instance save branch as defense-in-depth", () => {
    // Don't regress the existing createEffect save path — it still covers
    // any future scenario where conversationId() transitions without an
    // unmount (e.g. a non-keyed parent or an in-place rebind).
    expect(chatContentSource).toContain(
      "if (currentInput) {\n          chatDrafts.set(prevConversationId, currentInput);",
    );
  });
});
