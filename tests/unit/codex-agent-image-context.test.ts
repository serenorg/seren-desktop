// ABOUTME: Regression guard for #2016 — Agent Chat image attachments must
// ABOUTME: reach Codex app-server as image user input items, not disappear.

import { describe, expect, it } from "vitest";
// @ts-expect-error - providers.mjs is a plain ESM harness without type declarations
import { buildCodexTurnInput } from "../../bin/browser-local/providers.mjs";

describe("#2016 — Codex agent prompt preserves image context", () => {
  it("maps Agent Chat image context records to Codex image turn input items", () => {
    const input = buildCodexTurnInput("Why is this menu item missing?", [
      { type: "text", text: "Skill primer" },
      {
        type: "image",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        mimeType: "image/png",
      },
    ]);

    expect(input).toEqual([
      {
        type: "text",
        text: "Skill primer\n\nWhy is this menu item missing?",
        text_elements: [],
      },
      {
        type: "image",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      },
    ]);
  });
});
