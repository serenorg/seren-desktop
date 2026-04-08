// ABOUTME: Host compatibility helper for skill exclusion contract.
// ABOUTME: Implements the serenorg/seren-desktop#1496 host-marker spec.

import type { InstalledSkill, Skill } from "./types";
import type { SkillMetadata } from "./types";

/**
 * The host token injected by Seren Desktop at runtime.
 * Matches `SEREN_HOST` env var set in bin/provider-runtime.mjs.
 */
export const SEREN_DESKTOP_HOST = "seren-desktop" as const;

/**
 * Current runtime host identifier. Hardcoded because this code only ever
 * runs inside Seren Desktop — the env marker is for child processes.
 */
export const CURRENT_HOST = SEREN_DESKTOP_HOST;

/**
 * Check if a skill is compatible with the current host.
 * A skill is incompatible when its `excludeHosts` metadata contains the
 * current host token.
 */
export function isSkillCompatibleWithHost(
  metadata: Pick<SkillMetadata, "excludeHosts"> | undefined | null,
  host: string = CURRENT_HOST,
): boolean {
  if (!metadata?.excludeHosts || metadata.excludeHosts.length === 0) {
    return true;
  }
  return !metadata.excludeHosts.includes(host);
}

/**
 * Filter a list of installed skills to only those compatible with the
 * current host. Excluded skills are removed from discovery/search results.
 */
export function filterHostCompatibleSkills<T extends InstalledSkill>(
  skills: T[],
  hostMetadata: Map<string, SkillMetadata | undefined>,
  host: string = CURRENT_HOST,
): T[] {
  return skills.filter((skill) =>
    isSkillCompatibleWithHost(hostMetadata.get(skill.slug), host),
  );
}

/**
 * Filter available (catalog) skills by the `excludeHosts` field on index
 * entries. Used at catalog ingestion time to drop CLI-only skills.
 */
export function filterHostCompatibleCatalog<
  T extends Skill & { excludeHosts?: string[] },
>(catalog: T[], host: string = CURRENT_HOST): T[] {
  return catalog.filter(
    (entry) =>
      !entry.excludeHosts || !entry.excludeHosts.includes(host),
  );
}
