// ABOUTME: Pure helpers for Claude Code reasoning effort.
// ABOUTME: Extracted so buildClaudeArgs mapping can be unit-tested without spawning a process.

export const CLAUDE_EFFORT_VALUES = ["low", "medium", "high", "xhigh"];
export const DEFAULT_CLAUDE_EFFORT = "medium";

export function normalizeEffort(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return CLAUDE_EFFORT_VALUES.includes(trimmed) ? trimmed : null;
}

export function buildEffortArgs(effort) {
  const normalized = normalizeEffort(effort);
  return normalized ? ["--effort", normalized] : [];
}

export function buildEffortConfigOption(currentValue) {
  const current = normalizeEffort(currentValue) ?? DEFAULT_CLAUDE_EFFORT;
  return {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    description:
      "Controls how much extended thinking Claude Code does. Applies to the next session.",
    type: "select",
    currentValue: current,
    options: CLAUDE_EFFORT_VALUES.map((value) => ({
      value,
      name: value,
      description: null,
    })),
  };
}
