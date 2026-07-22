// ABOUTME: Regression guards for idempotent memory capture in generic tool-aware chat.
// ABOUTME: Requires a stable source ID and preserves it across continuation states.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatSource = readFileSync(resolve("src/services/chat.ts"), "utf-8");

describe("tool-aware chat memory idempotency", () => {
  it("requires a stable external source ID before capturing memory", () => {
    expect(chatSource).toMatch(
      /interface ToolMemorySource\s*{\s*sourceExternalId: string;/,
    );
    expect(
      chatSource.match(
        /finalOutputValidation\.canStoreMemory && memorySource/g,
      ),
    ).toHaveLength(2);
  });

  it("preserves source identity and the original query across continuations", () => {
    expect(chatSource.match(/memorySource,\s*userQuery:/g)).toHaveLength(1);
    expect(chatSource.match(/memorySource,\s*userQuery,/g)).toHaveLength(2);
    expect(chatSource).not.toContain("crypto.randomUUID()");
  });
});
