// ABOUTME: Parses slash command input and matches against the registry.
// ABOUTME: Returns parsed command or null if input is not a command.

import { registry } from "./registry";
import type { ParsedCommand } from "./types";

/**
 * Parse input text to see if it starts with a slash command.
 * Returns the matched command and remaining args, or null.
 */
export function parseCommand(
  input: string,
  panel: "chat" | "agent",
): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  // Extract command name (everything up to first space)
  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (!name) return null;

  const command = registry.get(name, panel);
  if (!command) return null;

  return { command, args };
}

/**
 * Get commands matching a partial input for autocomplete.
 * Input should start with "/" but the slash is stripped for matching.
 */
export function getCompletions(
  input: string,
  panel: "chat" | "agent",
): import("./types").SlashCommand[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return [];

  // Only complete if still typing the command name (no space yet)
  if (trimmed.includes(" ")) return [];

  const partial = trimmed.slice(1).toLowerCase();
  return registry.search(partial, panel);
}
