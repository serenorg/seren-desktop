// ABOUTME: Parses slash command input and matches against the registry.
// ABOUTME: Also searches installed skills for autocomplete and skill invocation dispatch.

import type { InstalledSkill } from "@/lib/skills";
import { skillsStore } from "@/stores/skills.store";
import { registry } from "./registry";
import type { ParsedCommand, SlashCommand } from "./types";

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
 * Searches built-in commands first, then installed skills as fallback.
 */
export function getCompletions(
  input: string,
  panel: "chat" | "agent",
): SlashCommand[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return [];

  // Only complete if still typing the command name (no space yet)
  if (trimmed.includes(" ")) return [];

  const partial = trimmed.slice(1).toLowerCase();
  const builtins = registry.search(partial, panel);
  const skillResults = searchInstalledSkills(partial);

  // Deduplicate: built-in commands win over skills with the same name
  const builtinNames = new Set(builtins.map((c) => c.name));
  const uniqueSkills = skillResults.filter((s) => !builtinNames.has(s.name));

  return [...builtins, ...uniqueSkills];
}

/**
 * Match a slash command input against installed skills.
 * Returns the matched skill and any trailing args, or null.
 */
export function matchSkillCommand(
  input: string,
): { skill: InstalledSkill; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (!name) return null;

  const lower = name.toLowerCase();
  const installed = skillsStore.installed;

  for (const skill of installed) {
    if (!skill.enabled) continue;
    if (skill.slug.toLowerCase() === lower) {
      return { skill, args };
    }
  }

  return null;
}

/**
 * Search installed skills whose slug or display name match a partial input.
 * Returns SlashCommand entries for the autocomplete popup.
 */
function searchInstalledSkills(partial: string): SlashCommand[] {
  const installed = skillsStore.installed;
  if (installed.length === 0) return [];

  const results: SlashCommand[] = [];
  for (const skill of installed) {
    if (!skill.enabled) continue;

    const slugMatch = skill.slug.toLowerCase().startsWith(partial);
    const nameMatch = skill.name.toLowerCase().startsWith(partial);
    if (!slugMatch && !nameMatch) continue;

    results.push({
      name: skill.slug,
      description: skill.name !== skill.slug ? skill.name : skill.description,
      argHint: "<prompt>",
      panels: ["chat", "agent"],
      isSkill: true,
      execute: () => false, // Skills are sent as regular messages, not intercepted
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}
