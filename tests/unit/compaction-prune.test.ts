// ABOUTME: Unit tests for tool/media-aware compaction pre-pruning (#2105).
// ABOUTME: Duplicate tool output, stale media, large results, oversized JSON args.

import { describe, expect, it } from "vitest";
import {
  type PrunableMessage,
  pruneCompactedHistory,
  truncateJsonArgs,
} from "@/lib/compaction/prune";

function tool(
  id: string,
  name: string,
  result: string,
  extra: Partial<PrunableMessage> = {},
): PrunableMessage {
  return { id, role: "tool", content: "", toolName: name, toolResult: result, ...extra };
}

describe("#2105 pruneCompactedHistory — duplicate tool output", () => {
  it("replaces older duplicate tool results with a back-reference to the newest copy", () => {
    const fileBody = "FILE CONTENTS ".repeat(50);
    const messages: PrunableMessage[] = [
      tool("t1", "read_file", fileBody),
      { id: "a1", role: "assistant", content: "thinking" },
      tool("t2", "read_file", fileBody), // newest identical read
    ];
    const { messages: out, stats } = pruneCompactedHistory(messages);
    expect(stats.duplicateToolResults).toBe(1);
    // Older copy becomes a back-reference; newest copy is retained (or summarized).
    expect(out[0].toolResult).toContain("duplicate of a more recent");
    expect(out[2].toolResult).not.toContain("duplicate of a more recent");
  });
});

describe("#2105 pruneCompactedHistory — stale large results", () => {
  it("summarizes a large tool result into a one-line information-bearing string", () => {
    const big = `first line of output\n${"x".repeat(5000)}`;
    const { messages: out, stats } = pruneCompactedHistory(
      [tool("t1", "run_command", big)],
      { maxToolResultChars: 800 },
    );
    expect(stats.summarizedToolResults).toBe(1);
    const summary = out[0].toolResult ?? "";
    expect(summary.length).toBeLessThan(big.length);
    // Information-bearing, not opaque: names the tool, size, and first line.
    expect(summary).toContain("run_command");
    expect(summary).toContain("first line of output");
    expect(summary).toContain("dropped at compaction");
  });
});

describe("#2105 pruneCompactedHistory — stale media", () => {
  it("strips old image payloads but keeps the latest media-bearing turn", () => {
    const messages: PrunableMessage[] = [
      { id: "u1", role: "user", content: "old screenshot", imageParts: 1 },
      { id: "u2", role: "user", content: "later", imageParts: 0 },
      { id: "u3", role: "user", content: "newest screenshot", imageParts: 2 },
    ];
    const { messages: out, stats } = pruneCompactedHistory(messages);
    expect(stats.strippedMediaParts).toBe(1);
    expect(out[0].imageParts).toBe(0);
    expect(out[0].content).toContain("image(s) removed");
    // Latest media-bearing turn is preserved intact.
    expect(out[2].imageParts).toBe(2);
  });
});

describe("#2105 pruneCompactedHistory — oversized tool-call arguments", () => {
  it("truncates large write_file args while keeping the JSON valid", () => {
    const args = JSON.stringify({
      path: "src/big.ts",
      content: "x".repeat(8000),
    });
    const { messages: out, stats } = pruneCompactedHistory(
      [tool("t1", "write_file", "ok", { toolArgs: args })],
      { maxToolArgChars: 500 },
    );
    expect(stats.truncatedToolArgs).toBe(1);
    const truncated = out[0].toolArgs ?? "";
    expect(truncated.length).toBeLessThan(args.length);
    // Still valid JSON, and the structural key survives.
    const parsed = JSON.parse(truncated);
    expect(parsed.path).toBe("src/big.ts");
    expect(parsed.content).toContain("truncated");
  });
});

describe("#2105 truncateJsonArgs", () => {
  it("wraps non-JSON payloads in a valid envelope", () => {
    const out = truncateJsonArgs("not json ".repeat(500), 100);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)._truncated).toBeDefined();
  });
});

describe("#2105 pruneCompactedHistory — protected tail and token reduction", () => {
  it("leaves the protected tail untouched and reduces estimated tokens", () => {
    const big = "DATA ".repeat(2000);
    const messages: PrunableMessage[] = [
      tool("t1", "read_file", big),
      tool("t2", "read_file", big), // duplicate of t1
      { id: "u1", role: "user", content: "keep me", imageParts: 1 }, // protected
    ];
    const { messages: out, stats } = pruneCompactedHistory(messages, {
      protectedFromIndex: 2,
    });
    // Protected tail message is unchanged.
    expect(out[2].content).toBe("keep me");
    expect(out[2].imageParts).toBe(1);
    expect(stats.tokensAfter).toBeLessThan(stats.tokensBefore);
  });
});
