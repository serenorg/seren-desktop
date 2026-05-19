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

export function skillDisplayName(skill: Skill | InstalledSkill): string {
  return (
    firstPresent(skill.displayName, skill.name, skill.slug) ?? "Unnamed Skill"
  );
}

export function resolveSkillListDisplayName(
  skill: Skill | InstalledSkill,
  catalog: readonly Skill[],
): string {
  if (!isInstalledSkill(skill) || !isSerenCatalogInstall(skill)) {
    return skillDisplayName(skill);
  }

  const match = catalog.find(
    (candidate) =>
      candidate.slug === skill.slug || candidate.slug === skill.dirName,
  );
  return match ? skillDisplayName(match) : skillDisplayName(skill);
}
