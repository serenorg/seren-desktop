// ABOUTME: Pure helpers for Claude Code per-turn token usage tracking.
// ABOUTME: Lets the runtime report peak-per-turn context instead of the misleading average.

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Total input tokens processed by the model in a single API turn.
 * Includes non-cached, cache-creation, and cache-read tokens, because all three
 * count toward the model's context window — only billing differs.
 */
export function perTurnInputTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return (
    nonNegativeNumber(usage.input_tokens) +
    nonNegativeNumber(usage.cache_creation_input_tokens) +
    nonNegativeNumber(usage.cache_read_input_tokens)
  );
}

/**
 * Returns the greater of a prior peak and the per-turn input for a new message.
 */
export function updatePeakInputTokens(prevPeak, usage) {
  const current = perTurnInputTokens(usage);
  const prior = nonNegativeNumber(prevPeak);
  return current > prior ? current : prior;
}
