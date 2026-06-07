// ABOUTME: Tool/media-aware pre-pruning of compacted history before summarization (#2105).
// ABOUTME: Dedupes tool output, summarizes stale results, strips old media, bounds JSON args.

import {
  type AccountedMessage,
  estimateAccountedMessageTokens,
} from "@/lib/compaction/token-accounting";

/** A transcript message in the shape the pruner needs. */
export interface PrunableMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "other";
  content: string;
  /** Tool result text (tool messages only). */
  toolResult?: string;
  /** Tool name/title for back-references and summaries. */
  toolName?: string;
  /** Tool-call arguments serialized as JSON (tool/assistant messages). */
  toolArgs?: string;
  /** Number of image/media parts on this message. */
  imageParts?: number;
}

export interface PruneOptions {
  /** Tool results longer than this are replaced with a one-line summary. Default 800. */
  maxToolResultChars?: number;
  /** Tool-call arguments longer than this are truncated (kept JSON-valid). Default 1000. */
  maxToolArgChars?: number;
  /**
   * Messages at index >= this are the protected tail and are left untouched.
   * Defaults to the full length (prune everything). Callers pass the active
   * tail boundary so the latest turn keeps its full fidelity.
   */
  protectedFromIndex?: number;
}

export interface PruneStats {
  duplicateToolResults: number;
  summarizedToolResults: number;
  strippedMediaParts: number;
  truncatedToolArgs: number;
  tokensBefore: number;
  tokensAfter: number;
}

export interface PruneResult {
  messages: PrunableMessage[];
  stats: PruneStats;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 800;
const DEFAULT_MAX_TOOL_ARG_CHARS = 1_000;

function toAccounted(m: PrunableMessage): AccountedMessage {
  return {
    content: m.content,
    toolArgs: m.toolArgs,
    toolResult: m.toolResult,
    imageParts: m.imageParts,
  };
}

function sumTokens(messages: PrunableMessage[], end: number): number {
  let total = 0;
  for (let i = 0; i < end; i++) {
    total += estimateAccountedMessageTokens(toAccounted(messages[i]));
  }
  return total;
}

/** One-line, information-bearing replacement for a large/stale tool result. */
function summarizeToolResult(m: PrunableMessage): string {
  const name = m.toolName ?? "tool";
  const raw = m.toolResult ?? "";
  const firstLine = raw.split("\n", 1)[0]?.slice(0, 120) ?? "";
  return `[${name} result — ${raw.length} chars; first line: "${firstLine}"; full output dropped at compaction]`;
}

/** Recursively shorten long string leaves so the result stays valid JSON. */
function truncateJsonValue(value: unknown, cap: number): unknown {
  if (typeof value === "string") {
    return value.length > cap ? `${value.slice(0, cap)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateJsonValue(v, cap));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = truncateJsonValue(
        (value as Record<string, unknown>)[key],
        cap,
      );
    }
    return out;
  }
  return value;
}

/**
 * Truncate large tool-call arguments while preserving JSON validity. Parses the
 * args and shortens long string leaves; if the payload is not valid JSON it is
 * wrapped in a valid `{ "_truncated": ... }` envelope rather than sliced into
 * malformed JSON that a downstream provider would reject. #2105.
 */
export function truncateJsonArgs(args: string, maxChars: number): string {
  if (args.length <= maxChars) return args;
  try {
    return JSON.stringify(truncateJsonValue(JSON.parse(args), maxChars));
  } catch {
    return JSON.stringify({ _truncated: args.slice(0, maxChars) });
  }
}

/**
 * Pre-prune compacted history outside the protected tail: dedupe repeated tool
 * output to back-references, summarize stale large results, strip old media
 * payloads (keeping the latest media-bearing turn intact), and bound oversized
 * tool-call arguments. Lowers both the summarizer input and the post-compaction
 * prompt size for tool-heavy and multimodal sessions.
 */
export function pruneCompactedHistory(
  messages: PrunableMessage[],
  options: PruneOptions = {},
): PruneResult {
  const maxToolResultChars =
    options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const maxToolArgChars = options.maxToolArgChars ?? DEFAULT_MAX_TOOL_ARG_CHARS;
  const protectedFrom = Math.min(
    options.protectedFromIndex ?? messages.length,
    messages.length,
  );

  const stats: PruneStats = {
    duplicateToolResults: 0,
    summarizedToolResults: 0,
    strippedMediaParts: 0,
    truncatedToolArgs: 0,
    tokensBefore: sumTokens(messages, protectedFrom),
    tokensAfter: 0,
  };

  const out = messages.map((m) => ({ ...m }));

  // Latest media-bearing message across the WHOLE transcript — its media is
  // kept so an active multimodal task still works.
  let latestMediaIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].imageParts ?? 0) > 0) {
      latestMediaIndex = i;
      break;
    }
  }

  // Seed dedupe with tool results that live in the protected tail so a pruned
  // older copy back-references the newest retained copy even when that copy is
  // in the tail.
  const seen = new Set<string>();
  for (let i = protectedFrom; i < messages.length; i++) {
    const r = messages[i].toolResult;
    if (messages[i].role === "tool" && r) seen.add(r);
  }

  // Walk newest -> oldest within the pruned region so the newest copy of a
  // duplicated result is the one retained.
  for (let i = protectedFrom - 1; i >= 0; i--) {
    const m = out[i];

    if (m.role === "tool" && m.toolResult) {
      if (seen.has(m.toolResult)) {
        m.toolResult = `[duplicate of a more recent ${m.toolName ?? "tool"} result — omitted at compaction]`;
        stats.duplicateToolResults++;
      } else {
        seen.add(m.toolResult);
        if (m.toolResult.length > maxToolResultChars) {
          m.toolResult = summarizeToolResult(m);
          stats.summarizedToolResults++;
        }
      }
    }

    // Strip stale media outside the latest media-bearing turn.
    if ((m.imageParts ?? 0) > 0 && i < latestMediaIndex) {
      const stripped = m.imageParts ?? 0;
      stats.strippedMediaParts += stripped;
      m.imageParts = 0;
      m.content = `${m.content}\n[${stripped} image(s) removed at compaction]`;
    }

    // Bound oversized tool-call arguments, keeping JSON valid.
    if (m.toolArgs && m.toolArgs.length > maxToolArgChars) {
      m.toolArgs = truncateJsonArgs(m.toolArgs, maxToolArgChars);
      stats.truncatedToolArgs++;
    }
  }

  stats.tokensAfter = sumTokens(out, protectedFrom);
  return { messages: out, stats };
}
