// ABOUTME: Resilient summarizer policy for compaction — fallback, cooldown, no-drop (#2106).
// ABOUTME: Shared by chat and agent paths so summarization failures never drop history.

/** Run the summary with a given model id; resolves to the summary text. */
export type SummarizerAttempt = (model: string) => Promise<string>;

export interface SummarizerPolicyInput {
  /** Preferred summarizer model. */
  primaryModel: string;
  /** Models tried, in order, when the primary fails or returns garbage. */
  fallbackModels?: string[];
  /** Invoke the summarizer with a model id. */
  attempt: SummarizerAttempt;
  /** Treat an error as an auth failure that a token refresh might fix. */
  isAuthError?: (err: unknown) => boolean;
  /** Refresh auth once on an auth error; resolves true if a refresh happened. */
  refreshAuth?: () => Promise<boolean>;
  /** Reject empty/garbage summaries so the policy falls through. Default: non-empty. */
  isValidSummary?: (summary: string) => boolean;
  /** Build a deterministic local summary when every model attempt fails. */
  deterministicFallback?: () => string;
}

export type SummarizerOutcome =
  | { status: "ok"; summary: string; model: string; usedFallbackModel: boolean }
  | { status: "fallback"; summary: string; reason: string }
  | { status: "aborted"; reason: string };

function defaultIsValidSummary(summary: string): boolean {
  return typeof summary === "string" && summary.trim().length > 0;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drive a summary through a resilient policy: primary model, auth-refresh retry,
 * fallback model(s), then a deterministic local summary. Only returns `aborted`
 * when no model AND no deterministic fallback can produce a summary — the caller
 * must then leave history intact (no-drop). #2106.
 */
export async function runSummarizerWithPolicy(
  input: SummarizerPolicyInput,
): Promise<SummarizerOutcome> {
  const {
    primaryModel,
    fallbackModels = [],
    attempt,
    isAuthError = () => false,
    refreshAuth,
    isValidSummary = defaultIsValidSummary,
    deterministicFallback,
  } = input;

  let lastError = "unknown summarizer failure";

  const tryModel = async (
    model: string,
  ): Promise<{ ok: true; summary: string } | { ok: false; err: unknown }> => {
    try {
      const summary = await attempt(model);
      if (isValidSummary(summary)) return { ok: true, summary };
      return {
        ok: false,
        err: new Error("summarizer returned an invalid summary"),
      };
    } catch (err) {
      return { ok: false, err };
    }
  };

  // Primary attempt.
  let result = await tryModel(primaryModel);
  if (result.ok) {
    return {
      status: "ok",
      summary: result.summary,
      model: primaryModel,
      usedFallbackModel: false,
    };
  }
  lastError = errMessage(result.err);

  // Auth-refresh retry on the primary, once.
  if (isAuthError(result.err) && refreshAuth) {
    const refreshed = await refreshAuth();
    if (refreshed) {
      result = await tryModel(primaryModel);
      if (result.ok) {
        return {
          status: "ok",
          summary: result.summary,
          model: primaryModel,
          usedFallbackModel: false,
        };
      }
      lastError = errMessage(result.err);
    }
  }

  // Fallback models, in order.
  for (const fallbackModel of fallbackModels) {
    const fallbackResult = await tryModel(fallbackModel);
    if (fallbackResult.ok) {
      return {
        status: "ok",
        summary: fallbackResult.summary,
        model: fallbackModel,
        usedFallbackModel: true,
      };
    }
    lastError = errMessage(fallbackResult.err);
  }

  // Deterministic local fallback so compaction can proceed without dropping
  // history even when the summarizer provider is fully unavailable.
  if (deterministicFallback) {
    try {
      const summary = deterministicFallback();
      if (summary && summary.trim().length > 0) {
        return { status: "fallback", summary, reason: lastError };
      }
    } catch (err) {
      lastError = errMessage(err);
    }
  }

  // No-drop abort: caller must keep the original history intact.
  return { status: "aborted", reason: lastError };
}

// ============================================================================
// Deterministic fallback summary
// ============================================================================

/** One compacted turn reduced to the fields the deterministic summary reads. */
export interface FallbackTurn {
  role: "user" | "assistant" | "system" | "tool" | "other";
  content: string;
  toolName?: string;
  toolResult?: string;
}

const RESOURCE_RE = /(?:https?:\/\/[^\s"'<>]+)|(?:[\w.@-]+\/[\w./@-]+)/g;

function clampText(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function extractResources(turns: FallbackTurn[]): string[] {
  const found = new Set<string>();
  for (const t of turns) {
    const haystack = `${t.content}\n${t.toolResult ?? ""}`;
    for (const match of haystack.matchAll(RESOURCE_RE)) {
      const token = match[0];
      if (token.length >= 3 && token.length <= 200) found.add(token);
    }
  }
  return Array.from(found).slice(0, 12);
}

/**
 * Build a conservative, clearly-marked fallback summary from the compacted
 * turns. It records only observable facts — the latest user ask, the tool names
 * that ran, and file/resource identifiers seen in the transcript — and never
 * asserts completed work. Marked as a fallback so downstream consumers re-verify.
 */
export function buildDeterministicFallbackSummary(
  turns: FallbackTurn[],
): string {
  const userAsks = turns
    .filter((t) => t.role === "user")
    .map((t) => t.content.trim())
    .filter((c) => c.length > 0);
  const latestAsk = userAsks.length
    ? clampText(userAsks[userAsks.length - 1], 280)
    : "none recorded";

  const toolNames = Array.from(
    new Set(
      turns
        .filter((t) => t.role === "tool" && t.toolName)
        .map((t) => t.toolName as string),
    ),
  );
  const resources = extractResources(turns);

  return [
    "[FALLBACK SUMMARY — generated locally without the summarizer model; incomplete. Re-read the workspace and verify before acting on any claim.]",
    "ACTIVE_TASK: none recorded (fallback)",
    "COMPLETED: none verified (fallback)",
    "IN_PROGRESS: none recorded (fallback)",
    "BLOCKERS: summarizer model was unavailable at compaction",
    "DECISIONS: none recorded (fallback)",
    `RESOURCES: ${resources.length ? resources.join(", ") : "none"}`,
    `REMAINING: ${
      toolNames.length
        ? `continue work involving tools: ${toolNames.join(", ")}`
        : "none recorded"
    }`,
    `LATEST_USER_REQUEST: ${latestAsk}`,
  ].join("\n");
}

// ============================================================================
// Cooldown
// ============================================================================

/** Default cooldown after a summarizer failure before auto-compact retries. */
export const DEFAULT_COMPACTION_COOLDOWN_MS = 60_000;

/**
 * Per-key cooldown so a failing summarizer is not hammered on every auto-compact
 * tick. Keyed by conversation id so it survives the session re-spawn that a
 * reactive compaction performs.
 */
export class CompactionCooldown {
  private until = new Map<string, number>();

  isCoolingDown(key: string, now: number): boolean {
    const expiry = this.until.get(key);
    if (expiry == null) return false;
    if (now >= expiry) {
      this.until.delete(key);
      return false;
    }
    return true;
  }

  enter(
    key: string,
    now: number,
    durationMs = DEFAULT_COMPACTION_COOLDOWN_MS,
  ): void {
    this.until.set(key, now + durationMs);
  }

  clear(key: string): void {
    this.until.delete(key);
  }
}

/** Process-wide cooldown shared by chat and agent compaction. */
export const compactionCooldown = new CompactionCooldown();
