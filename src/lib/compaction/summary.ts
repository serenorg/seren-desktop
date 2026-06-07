// ABOUTME: Shared iterative compaction-summary helper for chat and agent paths (#2103).
// ABOUTME: Carries a prior summary forward so repeated compactions never lose earlier context.

export type CompactionMode = "chat" | "agent";

export interface IterativeCompactionPromptInput {
  /**
   * The summary produced by an earlier compaction of the same conversation,
   * if any. When present the model updates it in place instead of rebuilding
   * from only the newest window — this is what prevents older compacted
   * context from disappearing after the second and later compactions.
   */
  previousSummary?: string | null;
  /** Pre-formatted transcript of the turns being compacted this round. */
  newTurns: string;
  mode: CompactionMode;
  /** Soft output cap passed to the model. Defaults to 200 tokens. */
  maxTokens?: number;
}

/**
 * Concrete continuation fields shared by chat and agent compaction. Replaces
 * the old free-form `NEXT: <what the user will likely ask next>` field, which
 * invited prediction instead of preservation. Every field is evidence-bucketed
 * so the model carries forward facts rather than confabulating to fill a shape.
 */
const SUMMARY_FIELDS = `ACTIVE_TASK: <the single concrete task currently being worked on; 'none' if idle>
COMPLETED: <only actions with an explicit verifiable artifact; format 'item — at <path or db.table>'; 'none' if no artifact has been produced>
IN_PROGRESS: <work started but not yet finished; 'none' if nothing is mid-flight>
BLOCKERS: <what is blocking progress; 'none' if unblocked>
DECISIONS: <key decisions or preferences established; 'none' if none>
RESOURCES: <relevant files, paths, projects, table names, IDs, or URLs referenced; 'none' if none>
REMAINING: <what the agent should do next to finish the active task; 'none' if nothing remains>
LATEST_USER_REQUEST: <the most recent concrete thing the user asked for, in their own terms>`;

const ANTI_FABRICATION =
  "If a field has nothing to report, write 'none' — DO NOT invent content to fill the shape. " +
  "Only list COMPLETED items that have explicit verifiable artifacts (a file path, a db.table, a command that ran).";

/**
 * Build the structured summary prompt. When `previousSummary` is supplied the
 * prompt frames the task as an iterative update — carry forward still-relevant
 * facts, drop superseded ones, and let the latest user request win on conflict.
 */
export function buildIterativeCompactionPrompt({
  previousSummary,
  newTurns,
  mode,
  maxTokens = 200,
}: IterativeCompactionPromptInput): string {
  const prior = normalizePriorSummary(previousSummary);
  const subject = mode === "agent" ? "AI agent conversation" : "conversation";

  const header = prior
    ? `You are maintaining a running summary of an ${subject}. Update the PREVIOUS SUMMARY using the NEW TURNS TO INCORPORATE below. Carry forward every still-relevant fact from the previous summary, drop facts the new turns supersede, and when the previous summary and the new turns conflict, the latest user request and the newest turns win.`
    : `Summarize this ${subject} into EXACTLY the structured format below.`;

  const constraints = `Each field must be 1-2 short sentences max. Total output must be under ${maxTokens} tokens. ${ANTI_FABRICATION}`;

  const previousBlock = prior
    ? `\n\nPREVIOUS SUMMARY (carry forward still-relevant facts):\n${prior}`
    : "";

  const turnsLabel = prior ? "NEW TURNS TO INCORPORATE" : "Conversation";

  return `${header} ${constraints}

${SUMMARY_FIELDS}${previousBlock}

${turnsLabel}:
${newTurns}

Structured summary:`;
}

/** Trailer appended to agent summaries before they are shown to the runtime. */
const VERIFY_BANNER_MARKER = "\n\nVERIFY-BEFORE-ACTING:";

/**
 * Strip runtime-only decoration from a stored summary so it can be safely fed
 * back in as `previousSummary` on the next compaction. Without this, the
 * VERIFY-BEFORE-ACTING instruction and the `[Auto-compaction restored prior
 * context]` / `Prior work summary:` prepend labels would nest on every
 * iteration, bloating the prompt and re-quoting instructions as facts.
 * Idempotent: normalizing an already-clean summary returns it unchanged.
 */
export function normalizePriorSummary(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;

  // Drop the VERIFY-BEFORE-ACTING runtime banner and anything after it.
  const bannerIdx = out.indexOf(VERIFY_BANNER_MARKER);
  if (bannerIdx !== -1) {
    out = out.slice(0, bannerIdx);
  }

  // Drop leading prepend labels, possibly stacked, in any order.
  let changed = true;
  while (changed) {
    changed = false;
    const trimmedStart = out.replace(/^\s+/, "");
    for (const label of [
      "[Auto-compaction restored prior context]",
      "Prior work summary:",
    ]) {
      if (trimmedStart.startsWith(label)) {
        out = trimmedStart.slice(label.length);
        changed = true;
      }
    }
  }

  return out.trim();
}

// ============================================================================
// Lineage metadata (#2103)
// ============================================================================

/**
 * Per-compaction lineage record. Stored on the compacted summary so callers
 * and telemetry can see whether a summary is a fresh build or an iterative
 * update, and how many compaction generations a conversation has been through.
 */
export interface SummaryLineage {
  /** Hash of the previous summary this one was built from (absent on gen 1). */
  previousSummaryHash?: string;
  /** Number of messages folded into the summary this round. */
  compactedMessageCount: number;
  /** Epoch ms when this summary was produced. */
  compactedAt: number;
  /** True when this summary iteratively updated a prior summary. */
  iterative: boolean;
  /** 1 for the first compaction, incremented on each subsequent one. */
  generation: number;
}

/**
 * Stable, dependency-free 32-bit FNV-1a hash rendered as hex. Used only to
 * detect summary identity/drift across generations — not for security.
 */
export function hashSummary(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compute the lineage record for a new compaction given the prior lineage and
 * the (normalized) previous summary that was carried forward.
 */
export function buildSummaryLineage({
  previousLineage,
  previousSummary,
  compactedMessageCount,
  now,
}: {
  previousLineage?: SummaryLineage | null;
  previousSummary?: string | null;
  compactedMessageCount: number;
  now: number;
}): SummaryLineage {
  const prior = normalizePriorSummary(previousSummary);
  const iterative = prior.length > 0;
  return {
    previousSummaryHash: iterative ? hashSummary(prior) : undefined,
    compactedMessageCount,
    compactedAt: now,
    iterative,
    generation: (previousLineage?.generation ?? 0) + 1,
  };
}
