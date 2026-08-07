// ABOUTME: Parses Claude Code and Codex CLI transcript lines into neutral session events.
// ABOUTME: Pure functions only — the terminal source owns all file I/O and ordering.

// Mobile bubbles are not a place to reproduce a 200KB tool payload. Bounding
// here rather than in the source keeps both CLIs on one limit.
const TEXT_MAX_CHARS = 8_000;
const TRUNCATION_MARKER = "\n… [truncated for Happy Mobile]";

function boundedText(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= TEXT_MAX_CHARS) return text;
  const prefixLength = Math.max(0, TEXT_MAX_CHARS - TRUNCATION_MARKER.length);
  let prefix = text.slice(0, prefixLength);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  // Never split a surrogate pair; a lone half is not valid UTF-16 on the wire.
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}${TRUNCATION_MARKER}`;
}

function parseLine(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    // A partially flushed final line is normal while tailing a live CLI.
    return null;
  }
}

function timestampOf(entry) {
  const parsed = Date.parse(entry?.timestamp ?? "");
  return Number.isFinite(parsed) ? { timestamp: parsed } : {};
}

/**
 * One line of a Claude Code transcript (`~/.claude/projects/<dir>/<id>.jsonl`).
 *
 * `thinking` blocks are deliberately dropped: they outnumber assistant text
 * roughly three to one in real transcripts, and the phone already learns the
 * agent is working from the busy status this emits.
 *
 * @param {string} line
 * @returns {Array<{kind: string, payload: Record<string, unknown>}>}
 */
export function parseClaudeTranscriptLine(line) {
  const entry = parseLine(line);
  if (!entry) return [];
  // Sub-agent traffic belongs to its own conversation, and meta lines are
  // bookkeeping the user never typed.
  if (entry.isSidechain === true || entry.isMeta === true) return [];
  const time = timestampOf(entry);
  const content = entry.message?.content;

  if (entry.type === "user") {
    if (typeof content === "string") {
      const text = boundedText(content);
      if (!text) return [];
      return [
        { kind: "user-message", payload: { text, ...time } },
        { kind: "status", payload: { status: "busy", ...time } },
      ];
    }
    if (!Array.isArray(content)) return [];
    return content
      .filter((block) => block?.type === "tool_result")
      .map((block) => ({
        kind: "tool-end",
        payload: {
          toolCallId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
          output: boundedText(
            typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          ),
          isError: block.is_error === true,
          ...time,
        },
      }));
  }

  if (entry.type !== "assistant" || !Array.isArray(content)) return [];
  // Every block of one assistant message shares its id, so the coalescer joins
  // them into a single bubble instead of one per block.
  const messageId =
    typeof entry.message?.id === "string" && entry.message.id.length > 0
      ? entry.message.id
      : undefined;
  const events = [];
  for (const block of content) {
    if (block?.type === "text") {
      const text = boundedText(block.text);
      if (text) events.push({ kind: "assistant-delta", payload: { text, messageId, ...time } });
    } else if (block?.type === "tool_use") {
      events.push({
        kind: "tool-start",
        payload: {
          toolCallId: typeof block.id === "string" ? block.id : undefined,
          toolName: typeof block.name === "string" ? block.name : undefined,
          input: block.input,
          ...time,
        },
      });
    }
  }
  // `tool_use` means the model is handing off and will speak again this turn.
  if (entry.message?.stop_reason === "end_turn") {
    events.push({ kind: "turn-complete", payload: { stopReason: "end_turn", ...time } });
  }
  return events;
}

const CODEX_TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const CODEX_TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

/**
 * One line of a Codex rollout transcript
 * (`~/.codex/sessions/**\/rollout-*-<id>.jsonl`).
 *
 * Codex records the same turn twice: `event_msg` entries are the user-facing
 * stream and `response_item` entries are the raw model exchange. Text is read
 * from `event_msg` only, so nothing is published twice; tool calls have no
 * `event_msg` equivalent and are read from `response_item`.
 *
 * @param {string} line
 * @returns {Array<{kind: string, payload: Record<string, unknown>}>}
 */
export function parseCodexTranscriptLine(line) {
  const entry = parseLine(line);
  if (!entry) return [];
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return [];
  const time = timestampOf(entry);

  if (entry.type === "event_msg") {
    switch (payload.type) {
      case "user_message": {
        const text = boundedText(payload.message);
        return text
          ? [
              { kind: "user-message", payload: { text, ...time } },
              { kind: "status", payload: { status: "busy", ...time } },
            ]
          : [];
      }
      case "agent_message": {
        const text = boundedText(payload.message);
        return text ? [{ kind: "assistant-delta", payload: { text, ...time } }] : [];
      }
      case "task_started":
        return [{ kind: "status", payload: { status: "busy", ...time } }];
      case "task_complete":
        return [{ kind: "turn-complete", payload: { stopReason: "completed", ...time } }];
      default:
        return [];
    }
  }

  if (entry.type !== "response_item") return [];
  if (CODEX_TOOL_CALL_TYPES.has(payload.type)) {
    return [
      {
        kind: "tool-start",
        payload: {
          toolCallId: typeof payload.call_id === "string" ? payload.call_id : undefined,
          toolName: typeof payload.name === "string" ? payload.name : undefined,
          input: payload.arguments ?? payload.input,
          ...time,
        },
      },
    ];
  }
  if (CODEX_TOOL_OUTPUT_TYPES.has(payload.type)) {
    return [
      {
        kind: "tool-end",
        payload: {
          toolCallId: typeof payload.call_id === "string" ? payload.call_id : undefined,
          output: boundedText(
            typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output),
          ),
          ...time,
        },
      },
    ];
  }
  return [];
}

/**
 * @param {"claude-code" | "codex"} agentType
 */
export function transcriptParserFor(agentType) {
  if (agentType === "claude-code") return parseClaudeTranscriptLine;
  if (agentType === "codex") return parseCodexTranscriptLine;
  return null;
}
