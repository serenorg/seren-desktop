// ABOUTME: Display helpers for skill rows that can exist locally and in catalog.
// ABOUTME: Keeps marketplace-backed installed skills visually aligned with catalog naming.

import type { InstalledSkill, Skill } from "./types";

function firstPresent(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function isInstalledSkill(
  skill: Skill | InstalledSkill,
): skill is InstalledSkill {
  return "dirName" in skill;
}

function isSerenCatalogInstall(skill: InstalledSkill): boolean {
  return (
    skill.upstreamSource === "seren" ||
    skill.syncState?.upstreamSource === "seren" ||
    skill.upstreamSourceUrl?.startsWith("seren-skills:") === true
  );
}

function addAlias(aliases: Set<string>, value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed) aliases.add(trimmed);
}

function skillSlugFromSerenSourceUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith("seren-skills:")) return null;
  const slug = trimmed.slice("seren-skills:".length).trim();
  return slug || null;
}

export function skillDisplayName(skill: Skill | InstalledSkill): string {
  return (
    firstPresent(skill.displayName, skill.name, skill.slug) ?? "Unnamed Skill"
  );
}

export function skillCommandAliases(skill: Skill | InstalledSkill): string[] {
  const aliases = new Set<string>();
  if (isInstalledSkill(skill)) {
    addAlias(aliases, skillSlugFromSerenSourceUrl(skill.upstreamSourceUrl));
    addAlias(
      aliases,
      skillSlugFromSerenSourceUrl(skill.syncState?.upstreamSourceUrl),
    );
    addAlias(aliases, skill.dirName);
  }
  addAlias(aliases, skill.slug);
  return [...aliases];
}

export function primarySkillCommandSlug(skill: Skill | InstalledSkill): string {
  return skillCommandAliases(skill)[0] ?? skill.slug;
}

export function skillMatchesCommandAlias(
  skill: Skill | InstalledSkill,
  command: string,
): boolean {
  const lower = command.toLowerCase();
  return skillCommandAliases(skill).some(
    (alias) => alias.toLowerCase() === lower,
  );
}

export function skillsShareCommandAlias(
  left: Skill | InstalledSkill,
  right: Skill | InstalledSkill,
): boolean {
  const leftAliases = new Set(
    skillCommandAliases(left).map((alias) => alias.toLowerCase()),
  );
  return skillCommandAliases(right).some((alias) =>
    leftAliases.has(alias.toLowerCase()),
  );
}

/**
 * True when `candidate` and `installed` describe the same publisher
 * record. Accepts three reconcile signals so org-namespaced catalog
 * slugs (`autumn-foo`) still match a local install whose dir is the
 * bare folder name (`foo`):
 *
 * 1. catalog.slug === installed.slug                  (default case)
 * 2. catalog.slug === installed.dirName               (local slug drift)
 * 3. catalog.skillFolderName === installed.dirName    (org-namespaced)
 */
export function catalogSkillMatchesInstalled(
  candidate: Skill,
  installed: InstalledSkill,
): boolean {
  if (candidate.slug === installed.slug) return true;
  if (candidate.slug === installed.dirName) return true;
  if (
    candidate.skillFolderName &&
    candidate.skillFolderName === installed.dirName
  ) {
    return true;
  }
  return false;
}

export function resolveSkillListDisplayName(
  skill: Skill | InstalledSkill,
  catalog: readonly Skill[],
): string {
  if (!isInstalledSkill(skill) || !isSerenCatalogInstall(skill)) {
    return skillDisplayName(skill);
  }

  const match = catalog.find((candidate) =>
    catalogSkillMatchesInstalled(candidate, skill),
  );
  return match ? skillDisplayName(match) : skillDisplayName(skill);
}
