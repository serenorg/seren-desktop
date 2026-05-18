// ABOUTME: Parses slash command input and matches against the registry.
// ABOUTME: Also searches installed skills for autocomplete and skill invocation dispatch.

import type { InstalledSkill } from "@/lib/skills";
import { skillsStore } from "@/stores/skills.store";
import { registry } from "./registry";
import { bestScore, scoreCandidate } from "./score";
import type { ParsedCommand, SlashCommand } from "./types";

export function isInvokableSkill(skill: InstalledSkill): boolean {
  return skill.enabled && skill.payloadStatus !== "failed";
}

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
 * Get commands matching a partial input for autocomplete. Input should start
 * with "/" but the slash is stripped for matching. Skills appear first
 * because they are where the platform's value lives; built-in commands
 * follow. Duplicate names are resolved in favour of the built-in so a skill
 * cannot shadow `/clear` or `/new`.
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
  const skills = searchInstalledSkills(partial);
  const builtins = registry.search(partial, panel);

  const builtinNames = new Set(builtins.map((c) => c.name));
  const uniqueSkills = skills.filter((s) => !builtinNames.has(s.name));

  return [...uniqueSkills, ...builtins];
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
    if (!isInvokableSkill(skill)) continue;
    // Issue #1917 — block invocation of skills whose payload didn't fully
    // land on disk. Letting the slash command through here would inject the
    // SKILL.md into the agent's system prompt with the absolute runtime
    // directory header pointing at an empty directory; the agent would then
    // scaffold from scratch. Treat failed-payload skills as if they don't
    // exist; the user sees them in the sidebar with their failure marker.
    if (skill.payloadStatus === "failed") continue;
    if (skill.slug.toLowerCase() === lower) {
      return { skill, args };
    }
  }

  return null;
}

/**
 * Resolve a skill slash command, refreshing the installed inventory once when
 * the in-memory store has not caught up with disk yet. This closes the fresh
 * startup path where a valid `/skill-slug` could fall through to the agent as
 * plain text before `skillsStore.refresh()` completed.
 */
export async function resolveSkillCommand(
  input: string,
): Promise<{ skill: InstalledSkill; args: string } | null> {
  const immediateMatch = matchSkillCommand(input);
  if (immediateMatch) return immediateMatch;

  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  await skillsStore.refreshInstalled();
  return matchSkillCommand(input);
}

/**
 * Search installed skills whose slug or display name match a partial input.
 * Returns SlashCommand entries for the autocomplete popup, ranked by
 * {@link scoreCandidate} (lower score = better match). Boundary and initials
 * matches let `arb` or `pab` find `prophet-arb-bot` — the old prefix-only
 * pass required typing the leading word.
 */
function searchInstalledSkills(partial: string): SlashCommand[] {
  const installed = skillsStore.installed;
  if (installed.length === 0) return [];

  const ranked: Array<{ cmd: SlashCommand; score: number }> = [];
  for (const skill of installed) {
    if (!isInvokableSkill(skill)) continue;
    // Hide failed-payload skills from autocomplete so the user can't
    // accidentally tab-complete into a skill we know we'd block (#1917).
    const score = bestScore(
      scoreCandidate(skill.slug, partial),
      scoreCandidate(skill.name, partial),
    );
    if (score === null) continue;

    ranked.push({
      cmd: {
        name: skill.slug,
        description: skill.name !== skill.slug ? skill.name : skill.description,
        argHint: "<prompt>",
        panels: ["chat", "agent"],
        isSkill: true,
        execute: () => false, // Skills are sent as regular messages, not intercepted
      },
      score,
    });
  }

  ranked.sort(
    (a, b) => a.score - b.score || a.cmd.name.localeCompare(b.cmd.name),
  );
  return ranked.map(({ cmd }) => cmd);
}
