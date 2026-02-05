// ABOUTME: Utility for formatting thinking duration with varied verbs.
// ABOUTME: Inspired by Claude Code's 52 rotating status verbs for personality.

/**
 * 52+ unique verbs for the duration display (80+ entries with weighting).
 * Organized by category with pyramid distribution:
 * - Common verbs appear multiple times for higher probability
 * - Quirky verbs add personality without overwhelming
 */
const DURATION_VERBS = [
  // Cognitive (common) - weighted for higher probability
  "Thought",
  "Thought",
  "Thought",
  "Reasoned",
  "Reasoned",
  "Pondered",
  "Pondered",
  "Analyzed",
  "Analyzed",
  "Considered",
  "Considered",
  "Processed",
  "Evaluated",
  "Reflected",
  "Deduced",
  "Inferred",

  // Cognitive (quirky) - ~18 unique
  "Cerebrated",
  "Cogitated",
  "Ruminated",
  "Deliberated",
  "Contemplated",
  "Meditated",
  "Mused",
  "Mulled",
  "Noodled",
  "Puzzled",
  "Speculated",
  "Theorized",

  // Physical metaphors (common) - weighted
  "Brewed",
  "Brewed",
  "Worked",
  "Worked",
  "Crafted",
  "Crafted",
  "Built",
  "Cooked",

  // Physical metaphors (quirky) - ~12+
  "Simmered",
  "Forged",
  "Marinated",
  "Distilled",
  "Percolated",
  "Steeped",
  "Conjured",
  "Kindled",
  "Baked",
  "Fermented",
  "Incubated",
  "Cultivated",
  "Whittled",
  "Sculpted",
  "Woven",
  "Tempered",

  // Technical/Creative - ~22
  "Synthesized",
  "Composed",
  "Formulated",
  "Devised",
  "Assembled",
  "Shaped",
  "Molded",
  "Engineered",
  "Architected",
  "Computed",
  "Derived",
  "Calculated",
  "Generated",
  "Rendered",
  "Compiled",
  "Constructed",
  "Designed",
  "Mapped",
  "Charted",
  "Drafted",
  "Sketched",
  "Plotted",

  // Whimsical/Rare
  "Concocted",
  "Dreamed",
  "Imagined",
  "Envisioned",
  "Hatched",
  "Germinated",
  "Spun",
  "Channeled",

  // Easter eggs (rare)
  "Serened", // Seren brand
  "Alchemized",
  "Transmuted",
  "Manifested",
  "Divined",
];

/**
 * Get a random verb for the duration display.
 * Uses pyramid distribution via the array structure.
 */
function getRandomVerb(): string {
  return DURATION_VERBS[Math.floor(Math.random() * DURATION_VERBS.length)];
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "1m 18s", "45s", "2m 5s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Format duration with a random verb prefix.
 * Returns object with verb and formatted duration for flexible display.
 */
export function formatDurationWithVerb(ms: number): {
  verb: string;
  duration: string;
} {
  return {
    verb: getRandomVerb(),
    duration: formatDuration(ms),
  };
}
