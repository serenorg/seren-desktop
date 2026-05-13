// ABOUTME: Serializes conversation messages for the Rust orchestrator.
// ABOUTME: Preserves assistant tool_calls[] + tool replies so the recency boost fires (#1895).

import type { UnifiedMessage } from "@/types/conversation";

/**
 * OpenAI-format tool_call object emitted on assistant messages. Matches what
 * the Rust `extract_recent_publishers` (src-tauri/src/orchestrator/chat_model_worker.rs)
 * reads at `tool_calls[].function.name`.
 */
interface SerializedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Shape of one serialized history row sent to the Rust orchestrator. */
export interface SerializedMessage extends Record<string, unknown> {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: SerializedToolCall[];
  tool_call_id?: string;
}

/**
 * Serialize conversation messages into the format expected by the Rust backend.
 *
 * The Rust `tool_relevance::extract_recent_publishers` walks this output
 * looking for `tool_calls[]` on assistant rows to compute the recency boost
 * added in #1283. The orchestrator chat path also forwards the history into
 * the gateway's OpenAI-compatible chat-completions endpoint, which requires
 * every entry in `tool_calls[]` to be followed by a matching
 * `role: "tool", tool_call_id` reply. Both invariants must hold:
 *
 * 1. Assistant rows carry `tool_calls[]` so the Rust recency boost can fire.
 * 2. Each tool_call is paired with the recorded tool result so the gateway
 *    accepts the conversation as well-formed across turn boundaries.
 *
 * Without (1), publishers like playwright, gmail, kraken age out of BM25 the
 * moment the next user prompt doesn't share keywords with the tool docs (#1895).
 * Without (2), the gateway 400s with "messages must include a tool message
 * after assistant tool_calls".
 */
export function serializeHistory(
  messages: UnifiedMessage[],
): SerializedMessage[] {
  const out: SerializedMessage[] = [];
  let pendingAssistantIdx: number | null = null;

  const flushPendingAssistant = () => {
    pendingAssistantIdx = null;
  };

  for (const m of messages) {
    if (m.status !== "complete") continue;

    if (m.type === "tool_call" && m.toolCall) {
      // Attach this tool call to the most recent assistant row. If there is
      // no preceding assistant row, drop the call — orphan tool calls would
      // violate the OpenAI contract regardless.
      if (pendingAssistantIdx === null) continue;
      const assistant = out[pendingAssistantIdx];
      const name = m.toolCall.name ?? m.toolCall.kind ?? m.toolCall.title;
      if (!name) continue;
      const calls = (assistant.tool_calls ??= []);
      calls.push({
        id: m.toolCall.toolCallId,
        type: "function",
        function: {
          name,
          arguments: m.toolCall.arguments ?? "",
        },
      });
      continue;
    }

    if (m.type === "tool_result" && m.toolCallId) {
      // Emit the matching tool reply so the OpenAI contract is satisfied for
      // the historical turn. The Rust worker loop rebuilds the live turn's
      // tool messages independently — this branch only restores the bridge
      // for tool calls that already completed in earlier turns.
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      });
      // A tool result terminates a tool-call sequence; the next tool_call row
      // must belong to a new assistant turn, not this one.
      flushPendingAssistant();
      continue;
    }

    // Local UI affordances do not belong in gateway history.
    if (
      m.type === "transition" ||
      m.type === "reroute" ||
      m.type === "diff" ||
      m.type === "thought" ||
      m.type === "error"
    ) {
      continue;
    }

    if (m.role !== "user" && m.role !== "assistant") continue;

    const serialized: SerializedMessage = {
      role: m.role,
      content: m.content,
    };
    out.push(serialized);
    pendingAssistantIdx = m.role === "assistant" ? out.length - 1 : null;
  }

  return dropOrphanToolCalls(out);
}

/**
 * Belt-and-braces: if an assistant row ended up with tool_calls but the
 * stream was cut before the corresponding tool_result rows were persisted,
 * strip the orphaned ids so the gateway doesn't reject the payload. Mutates
 * each affected assistant in place rather than copying the full array.
 */
function dropOrphanToolCalls(out: SerializedMessage[]): SerializedMessage[] {
  const seenToolReplyIds = new Set<string>();
  for (const msg of out) {
    if (msg.role === "tool" && typeof msg.tool_call_id === "string") {
      seenToolReplyIds.add(msg.tool_call_id);
    }
  }
  for (const msg of out) {
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    const kept = msg.tool_calls.filter((tc) => seenToolReplyIds.has(tc.id));
    if (kept.length === 0) {
      delete msg.tool_calls;
    } else {
      msg.tool_calls = kept;
    }
  }
  return out;
}
