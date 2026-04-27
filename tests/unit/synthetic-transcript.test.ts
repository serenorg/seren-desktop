// ABOUTME: Critical tests for #1713 — buildSyntheticTranscript splice safety.
// ABOUTME: Guards parentUuid chain, sessionId rewrite, tail boundary, and tool-use slicing.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/synthetic-transcript.mjs",
  import.meta.url,
).href;
const {
  buildSyntheticTranscript,
  buildSyntheticTranscriptRecords,
  findCutIndex,
  isRealUserTurn,
} = await import(/* @vite-ignore */ modulePath);

interface JsonlRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  message?: { content?: unknown };
  isCompactSummary?: boolean;
  isSyntheticAck?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: test-only structural access
  [key: string]: any;
}

function userTurn(uuid: string, parentUuid: string | null, text: string) {
  return {
    parentUuid,
    isSidechain: false,
    promptId: "p-stub",
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    uuid,
    timestamp: "2026-04-27T00:00:00.000Z",
    permissionMode: "auto",
    userType: "external",
    entrypoint: "claude-code",
    cwd: "/tmp/test",
    sessionId: "PARENT",
    version: "2.1.118",
    gitBranch: "main",
  };
}

function assistantTextTurn(uuid: string, parentUuid: string, text: string) {
  return {
    parentUuid,
    isSidechain: false,
    message: {
      model: "claude-opus-4-7",
      id: `msg_${uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    requestId: `req_${uuid}`,
    type: "assistant",
    uuid,
    timestamp: "2026-04-27T00:00:01.000Z",
    userType: "external",
    entrypoint: "claude-code",
    cwd: "/tmp/test",
    sessionId: "PARENT",
    version: "2.1.118",
    gitBranch: "main",
  };
}

function assistantToolUseTurn(
  uuid: string,
  parentUuid: string,
  toolUseId: string,
) {
  return {
    parentUuid,
    isSidechain: false,
    message: {
      model: "claude-opus-4-7",
      id: `msg_${uuid}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Bash",
          input: { command: "ls" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    requestId: `req_${uuid}`,
    type: "assistant",
    uuid,
    timestamp: "2026-04-27T00:00:02.000Z",
    sessionId: "PARENT",
  };
}

function userToolResultTurn(
  uuid: string,
  parentUuid: string,
  toolUseId: string,
) {
  return {
    parentUuid,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: toolUseId,
          type: "tool_result",
          content: "ok",
          is_error: false,
        },
      ],
    },
    uuid,
    timestamp: "2026-04-27T00:00:03.000Z",
    sessionId: "PARENT",
  };
}

function attachmentRecord(parentUuid: string) {
  return {
    parentUuid,
    isSidechain: false,
    attachment: { type: "deferred_tools_delta", addedNames: ["Foo"] },
  };
}

describe("isRealUserTurn (#1713 — exchange boundary detection)", () => {
  it("treats user record with text blocks as a real turn", () => {
    expect(isRealUserTurn(userTurn("u1", null, "hi"))).toBe(true);
  });

  it("treats user record with only tool_result blocks as not real (mid-tool-use)", () => {
    expect(isRealUserTurn(userToolResultTurn("u2", "a1", "toolu_x"))).toBe(false);
  });

  it("rejects assistant records and malformed input", () => {
    expect(isRealUserTurn(assistantTextTurn("a1", "u1", "ok"))).toBe(false);
    expect(isRealUserTurn(null)).toBe(false);
    expect(isRealUserTurn({ type: "user" })).toBe(false);
  });
});

describe("findCutIndex (#1713 — preserve last N user-keyed exchanges)", () => {
  it("returns -1 when fewer real user turns exist than preserveCount", () => {
    const records = [userTurn("u1", null, "only one")];
    expect(findCutIndex(records, 2)).toBe(-1);
  });

  it("includes intermediate tool-use chains in the retained tail", () => {
    // Layout:
    //   0 user(u1) → 1 assistant(a1, tool_use) → 2 user(t1, tool_result)
    //   3 assistant(a2, text) → 4 user(u2) → 5 assistant(a3, text)
    // preserveCount=1 should cut at index 4 (the latest real user turn).
    const records = [
      userTurn("u1", null, "first"),
      assistantToolUseTurn("a1", "u1", "toolu_x"),
      userToolResultTurn("t1", "a1", "toolu_x"),
      assistantTextTurn("a2", "t1", "done"),
      userTurn("u2", "a2", "second"),
      assistantTextTurn("a3", "u2", "ok"),
    ];
    expect(findCutIndex(records, 1)).toBe(4);
  });

  it("retains the full tool-use chain when preserveCount spans it", () => {
    const records = [
      userTurn("u1", null, "first"),
      assistantToolUseTurn("a1", "u1", "toolu_x"),
      userToolResultTurn("t1", "a1", "toolu_x"),
      assistantTextTurn("a2", "t1", "done"),
      userTurn("u2", "a2", "second"),
      assistantTextTurn("a3", "u2", "ok"),
    ];
    // preserveCount=2 cuts at u1 (index 0) — keeps everything.
    expect(findCutIndex(records, 2)).toBe(0);
  });
});

describe("buildSyntheticTranscriptRecords (#1713 — splice safety, Codex P1)", () => {
  const baseArgs = {
    summaryText: "Prior conversation summary.",
    preserveCount: 1,
    syntheticSessionId: "NEW-SESSION-UUID",
    summaryUuid: "SUMMARY-UUID",
    ackUuid: "ACK-UUID",
    ackTimestamp: "2026-04-27T12:00:00.000Z",
  };

  it("rewrites first retained record's parentUuid to chain off the synthetic ack", () => {
    const parent = [
      userTurn("u1", null, "old"),
      assistantTextTurn("a1", "u1", "old reply"),
      userTurn("u2", "a1", "current"),
      assistantTextTurn("a2", "u2", "current reply"),
    ];
    const out = buildSyntheticTranscriptRecords({
      ...baseArgs,
      parentRecords: parent,
    }) as JsonlRecord[];

    // Layout: [summary, ack, u2, a2]
    expect(out[0].uuid).toBe("SUMMARY-UUID");
    expect(out[0].parentUuid).toBeNull();
    expect(out[1].uuid).toBe("ACK-UUID");
    expect(out[1].parentUuid).toBe("SUMMARY-UUID");
    expect(out[2].uuid).toBe("u2");
    expect(out[2].parentUuid).toBe("ACK-UUID"); // rewritten from "a1"
    expect(out[3].uuid).toBe("a2");
    expect(out[3].parentUuid).toBe("u2"); // preserved verbatim inside the tail
  });

  it("rewrites sessionId on every retained record while preserving inner uuids", () => {
    const parent = [
      userTurn("u1", null, "old"),
      userTurn("u2", "u1", "current"),
      assistantTextTurn("a2", "u2", "current reply"),
    ];
    const out = buildSyntheticTranscriptRecords({
      ...baseArgs,
      parentRecords: parent,
    }) as JsonlRecord[];

    for (const rec of out) {
      if (Object.hasOwn(rec, "sessionId")) {
        expect(rec.sessionId).toBe("NEW-SESSION-UUID");
      }
    }
    // Inner uuids of retained records are NOT rewritten (chain integrity).
    expect(out[2].uuid).toBe("u2");
    expect(out[3].uuid).toBe("a2");
  });

  it("preserves attachment records that chain off retained turns", () => {
    const parent = [
      userTurn("u1", null, "old"),
      userTurn("u2", "u1", "current"),
      attachmentRecord("u2"),
      assistantTextTurn("a2", "u2", "reply"),
    ];
    const out = buildSyntheticTranscriptRecords({
      ...baseArgs,
      parentRecords: parent,
    }) as JsonlRecord[];

    // [summary, ack, u2, attachment, a2]
    expect(out).toHaveLength(5);
    expect(out[3].attachment).toBeDefined();
    // Attachment chains via parentUuid to u2 — verbatim, NOT rewritten to ack.
    expect(out[3].parentUuid).toBe("u2");
  });

  it("retains tool_use/tool_result chain inside the preserved tail", () => {
    const parent = [
      userTurn("u1", null, "first"),
      userTurn("u2", "u1", "do the thing"),
      assistantToolUseTurn("a1", "u2", "toolu_x"),
      userToolResultTurn("t1", "a1", "toolu_x"),
      assistantTextTurn("a2", "t1", "done"),
    ];
    const out = buildSyntheticTranscriptRecords({
      ...baseArgs,
      parentRecords: parent,
    }) as JsonlRecord[];

    // [summary, ack, u2 (parentUuid rewritten), a1, t1, a2]
    expect(out).toHaveLength(6);
    expect(out[2].uuid).toBe("u2");
    expect(out[2].parentUuid).toBe("ACK-UUID");
    expect(out[3].uuid).toBe("a1");
    expect(out[3].parentUuid).toBe("u2"); // tool_use chain unchanged
    expect(out[4].uuid).toBe("t1");
    expect(out[4].parentUuid).toBe("a1"); // tool_result chain unchanged
  });

  it("throws when parent has fewer real user turns than preserveCount (caller falls back)", () => {
    expect(() =>
      buildSyntheticTranscriptRecords({
        ...baseArgs,
        parentRecords: [userTurn("u1", null, "only one")],
        preserveCount: 2,
      }),
    ).toThrow(/Not enough real user turns/);
  });

  it("flags summary record with isCompactSummary so downstream code can identify it", () => {
    const parent = [
      userTurn("u1", null, "first"),
      userTurn("u2", "u1", "second"),
    ];
    const out = buildSyntheticTranscriptRecords({
      ...baseArgs,
      parentRecords: parent,
    }) as JsonlRecord[];
    expect(out[0].isCompactSummary).toBe(true);
    expect(out[1].isSyntheticAck).toBe(true);
  });
});

describe("buildSyntheticTranscript (#1713 — round-trip on disk)", () => {
  it("writes a JSONL file that re-parses to the same records", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "syn-transcript-"));
    const parentPath = path.join(dir, "parent.jsonl");
    const outputPath = path.join(dir, "synthetic.jsonl");
    const parent = [
      userTurn("u1", null, "old"),
      assistantTextTurn("a1", "u1", "old reply"),
      userTurn("u2", "a1", "current"),
      assistantTextTurn("a2", "u2", "current reply"),
    ];
    writeFileSync(
      parentPath,
      parent.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const result = await buildSyntheticTranscript({
      parentJsonlPath: parentPath,
      outputJsonlPath: outputPath,
      summaryText: "summary",
      preserveCount: 1,
      syntheticSessionId: "NEW-UUID",
    });

    expect(result.syntheticSessionId).toBe("NEW-UUID");
    expect(result.retainedRecords).toBe(2);

    const written = readFileSync(outputPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(written).toHaveLength(4);
    expect(written[0].isCompactSummary).toBe(true);
    expect(written[2].uuid).toBe("u2");
    expect(written[2].parentUuid).toBe(result.ackUuid);
    expect(written[3].sessionId).toBe("NEW-UUID");
  });
});
