// ABOUTME: Pure helpers for rendering eval-drift deltas in the employee detail UI.
// ABOUTME: Returns sign-aware labels with a tone hint so the card can colour deltas consistently.

export type DriftTone = "good" | "warn" | "neutral";

export interface DriftDeltaLabel {
  text: string;
  tone: DriftTone;
}

/**
 * Format a signed delta as a directional, sign-aware label. Returns null when
 * the delta is absent or unknown so callers can omit the row entirely. When
 * `lowerIsBetter` is true, negative deltas are tinted "good" (e.g. failed count
 * dropped); when false, positive deltas are "good" (e.g. passed count rose).
 */
export function formatDriftDelta(
  delta: number | null | undefined,
  lowerIsBetter: boolean,
): DriftDeltaLabel | null {
  if (typeof delta !== "number" || Number.isNaN(delta)) return null;
  if (delta === 0) return { text: "no change", tone: "neutral" };
  const arrow = delta > 0 ? "up" : "down";
  const text = `${arrow} ${Math.abs(delta)}`;
  const isImprovement = lowerIsBetter ? delta < 0 : delta > 0;
  return { text, tone: isImprovement ? "good" : "warn" };
}
