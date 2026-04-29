// ABOUTME: Build synthetic Claude Code JSONL transcripts for predictive compaction (#1713).
// ABOUTME: Slices the parent's tail, prepends a structured summary turn pair, rewrites session/parent ids.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

// Action-oriented framing (#1733): the prior wording "Understood. Context
// restored from summary. Continuing from prior conversation." primed the
// promoted standby into another acknowledgement turn instead of the next
// agentic action — see the questionnaire-stall repro. Keep this short and
// active so the agent's next turn picks up the user's flow rather than
// re-confirming context receipt.
const SYNTHETIC_ACK_TEXT = "Resuming the task.";
const SYNTHETIC_MODEL_FALLBACK = "claude-opus-4-7[1m]";

/**
 * Determine whether a parsed JSONL record is a "real" user turn — i.e., a
 * fresh user prompt rather than a tool_result continuation. Tool_result-only
 * user records are part of an in-progress assistant tool-use chain and must
 * not be treated as exchange boundaries.
 */
export function isRealUserTurn(record) {
  if (!record || record.type !== "user") return false;
  const content = record.message?.content;
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block && block.type !== "tool_result");
}

/**
 * Locate the cut index: the parent-records index from which to retain the
 * tail. We scan for "real" user turns and pick the position of the
 * preserveCount-th-from-last one. Returns -1 when there are not enough
 * real user turns to satisfy preserveCount (caller must fall back).
 */
export function findCutIndex(records, preserveCount) {
  if (preserveCount <= 0) return records.length;
  const realUserIndices = [];
  for (let i = 0; i < records.length; i += 1) {
    if (isRealUserTurn(records[i])) realUserIndices.push(i);
  }
  if (realUserIndices.length < preserveCount) return -1;
  return realUserIndices[realUserIndices.length - preserveCount];
}

/**
 * Pull envelope fields (cwd, version, gitBranch, permissionMode, entrypoint,
 * userType) from the retained tail. These are required by the CLI on user
 * records — synthesizing without them risks `--resume` rejection.
 */
function inferEnvelope(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (!r || (r.type !== "user" && r.type !== "assistant")) continue;
    return {
      cwd: r.cwd ?? null,
      version: r.version ?? null,
      gitBranch: r.gitBranch ?? null,
      permissionMode: r.permissionMode ?? "default",
      entrypoint: r.entrypoint ?? "claude-code",
      userType: r.userType ?? "external",
      model:
        (r.type === "assistant" && r.message?.model) ||
        SYNTHETIC_MODEL_FALLBACK,
    };
  }
  return {
    cwd: null,
    version: null,
    gitBranch: null,
    permissionMode: "default",
    entrypoint: "claude-code",
    userType: "external",
    model: SYNTHETIC_MODEL_FALLBACK,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Build the synthetic transcript records (pure function). Given a list of
 * parsed parent records and a structured summary text, returns the records
 * that should be written to the new JSONL.
 *
 * Splice safety per #1713 / Codex P1:
 * - Every retained record's `sessionId` is rewritten to syntheticSessionId.
 * - The first retained user/assistant record's `parentUuid` is rewritten to
 *   chain off the synthetic ack's uuid.
 * - Inner parentUuid chain across the retained tail is preserved verbatim.
 * - Non-message records (attachment, file-history-snapshot, queue-operation,
 *   ai-title, last-prompt) are preserved with sessionId rewritten when present.
 */
export function buildSyntheticTranscriptRecords({
  parentRecords,
  summaryText,
  preserveCount,
  syntheticSessionId,
  summaryUuid,
  ackUuid,
  ackTimestamp,
}) {
  if (!Array.isArray(parentRecords)) {
    throw new TypeError("parentRecords must be an array");
  }
  if (typeof summaryText !== "string" || summaryText.length === 0) {
    throw new TypeError("summaryText must be a non-empty string");
  }
  if (!Number.isInteger(preserveCount) || preserveCount <= 0) {
    throw new TypeError("preserveCount must be a positive integer");
  }
  if (!syntheticSessionId || !summaryUuid || !ackUuid) {
    throw new TypeError("syntheticSessionId, summaryUuid, ackUuid are required");
  }

  const cutIndex = findCutIndex(parentRecords, preserveCount);
  if (cutIndex < 0) {
    throw new Error(
      `Not enough real user turns in parent transcript to preserve ${preserveCount}.`,
    );
  }

  const envelope = inferEnvelope(parentRecords);
  const ts = ackTimestamp || nowIso();

  const summaryRecord = {
    parentUuid: null,
    isSidechain: false,
    promptId: randomUUID(),
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: summaryText }],
    },
    uuid: summaryUuid,
    timestamp: ts,
    permissionMode: envelope.permissionMode,
    userType: envelope.userType,
    entrypoint: envelope.entrypoint,
    cwd: envelope.cwd,
    sessionId: syntheticSessionId,
    version: envelope.version,
    gitBranch: envelope.gitBranch,
    isCompactSummary: true,
  };

  const ackRecord = {
    parentUuid: summaryUuid,
    isSidechain: false,
    message: {
      model: envelope.model,
      id: `msg_synthetic_${ackUuid.replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: SYNTHETIC_ACK_TEXT }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        service_tier: "standard",
      },
    },
    requestId: `req_synthetic_${ackUuid.replace(/-/g, "")}`,
    type: "assistant",
    uuid: ackUuid,
    timestamp: ts,
    userType: envelope.userType,
    entrypoint: envelope.entrypoint,
    cwd: envelope.cwd,
    sessionId: syntheticSessionId,
    version: envelope.version,
    gitBranch: envelope.gitBranch,
    isSyntheticAck: true,
  };

  const tail = parentRecords.slice(cutIndex);
  let firstMessageRewritten = false;
  const retained = tail.map((record) => {
    const next = { ...record };
    if (Object.hasOwn(next, "sessionId")) {
      next.sessionId = syntheticSessionId;
    }
    if (
      !firstMessageRewritten &&
      (next.type === "user" || next.type === "assistant")
    ) {
      next.parentUuid = ackUuid;
      firstMessageRewritten = true;
    }
    return next;
  });

  if (!firstMessageRewritten) {
    throw new Error(
      "Retained tail contained no user/assistant records — splice would orphan the summary.",
    );
  }

  return [summaryRecord, ackRecord, ...retained];
}

/**
 * Read a JSONL file, parsing each line. Malformed lines are skipped with a
 * console warning rather than aborting — the parent transcript may have
 * legitimate non-JSON debugging output the CLI tolerates.
 */
export async function readJsonlFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const records = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      console.warn(
        `[synthetic-transcript] Skipping malformed JSONL line ${i + 1} of ${filePath}: ${err.message}`,
      );
    }
  }
  return records;
}

/**
 * Top-level builder: reads parent JSONL, constructs synthetic records, writes
 * them to outputPath. Returns metadata. Caller wraps in try/catch and falls
 * through to legacy seed-prompt path on any failure.
 */
export async function buildSyntheticTranscript({
  parentJsonlPath,
  outputJsonlPath,
  summaryText,
  preserveCount,
  syntheticSessionId,
}) {
  const parentRecords = await readJsonlFile(parentJsonlPath);
  if (parentRecords.length === 0) {
    throw new Error(`Parent transcript is empty: ${parentJsonlPath}`);
  }

  const summaryUuid = randomUUID();
  const ackUuid = randomUUID();
  const records = buildSyntheticTranscriptRecords({
    parentRecords,
    summaryText,
    preserveCount,
    syntheticSessionId,
    summaryUuid,
    ackUuid,
    ackTimestamp: nowIso(),
  });

  const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(outputJsonlPath, payload, "utf8");

  return {
    syntheticSessionId,
    syntheticJsonlPath: outputJsonlPath,
    summaryUuid,
    ackUuid,
    retainedRecords: records.length - 2,
  };
}

export const SYNTHETIC_TRANSCRIPT_INTERNALS = {
  SYNTHETIC_ACK_TEXT,
  SYNTHETIC_MODEL_FALLBACK,
};

/**
 * Static self-check used by the cli-updater hook (#1654 / #1713 §4.7).
 * Runs the splice-builder against a known-good fixture and validates the
 * output's invariant fields. Returns `{ ok: true }` on success, `{ ok:
 * false, reason }` on schema drift. Does NOT touch the CLI or disk.
 *
 * Caller (cli-updater) treats `{ ok: false }` as a signal to disable the
 * synthetic-transcript path (keep flag forced off) until the underlying
 * schema is reconciled.
 */
export function runSyntheticTranscriptSelfCheck() {
  const baseEnvelope = {
    isSidechain: false,
    permissionMode: "default",
    userType: "external",
    entrypoint: "claude-code",
    cwd: "/tmp/selfcheck",
    sessionId: "OLD",
    version: "self-check",
    gitBranch: "main",
  };
  const u1 = "00000000-0000-0000-0000-000000000001";
  const a1 = "00000000-0000-0000-0000-000000000002";
  const u2 = "00000000-0000-0000-0000-000000000003";
  const a2 = "00000000-0000-0000-0000-000000000004";
  const parent = [
    {
      ...baseEnvelope,
      parentUuid: null,
      promptId: "p1",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "old" }] },
      uuid: u1,
      timestamp: "2026-04-27T00:00:00.000Z",
    },
    {
      ...baseEnvelope,
      parentUuid: u1,
      message: {
        model: "claude-opus-4-7",
        id: `msg_${a1}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "old reply" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: {},
      },
      requestId: `req_${a1}`,
      type: "assistant",
      uuid: a1,
      timestamp: "2026-04-27T00:00:01.000Z",
    },
    {
      ...baseEnvelope,
      parentUuid: a1,
      promptId: "p2",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "current" }] },
      uuid: u2,
      timestamp: "2026-04-27T00:00:02.000Z",
    },
    {
      ...baseEnvelope,
      parentUuid: u2,
      message: {
        model: "claude-opus-4-7",
        id: `msg_${a2}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: {},
      },
      requestId: `req_${a2}`,
      type: "assistant",
      uuid: a2,
      timestamp: "2026-04-27T00:00:03.000Z",
    },
  ];
  try {
    const out = buildSyntheticTranscriptRecords({
      parentRecords: parent,
      summaryText: "self-check summary",
      preserveCount: 1,
      syntheticSessionId: "NEW",
      summaryUuid: "S",
      ackUuid: "A",
      ackTimestamp: "2026-04-27T00:00:04.000Z",
    });
    if (out.length !== 4) return { ok: false, reason: "unexpected length" };
    if (out[0].type !== "user" || out[0].parentUuid !== null)
      return { ok: false, reason: "summary record shape drift" };
    if (out[1].type !== "assistant" || out[1].parentUuid !== "S")
      return { ok: false, reason: "ack record shape drift" };
    if (out[2].uuid !== u2 || out[2].parentUuid !== "A")
      return { ok: false, reason: "splice boundary drift" };
    if (out[3].uuid !== a2 || out[3].parentUuid !== u2)
      return { ok: false, reason: "tail chain drift" };
    for (const r of out) {
      if (Object.hasOwn(r, "sessionId") && r.sessionId !== "NEW") {
        return { ok: false, reason: "sessionId rewrite drift" };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}
