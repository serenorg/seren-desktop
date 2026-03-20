// ABOUTME: Test publisher skill lifecycle management.
// ABOUTME: Verifies isPublisherManagedSkill guard and stale publisher detection.

import { describe, expect, it } from "vitest";
import type { InstalledSkill, SkillSyncState } from "@/lib/skills/types";

/**
 * Inline copy of isPublisherManagedSkill for testing without Tauri deps.
 * Must match the implementation in src/services/skills.ts.
 */
function isPublisherManagedSkill(
  skill: InstalledSkill,
): boolean {
  return (
    !!skill.syncState &&
    skill.upstreamSource === "seren" &&
    typeof skill.upstreamSourceUrl === "string" &&
    skill.upstreamSourceUrl.length > 0
  );
}

function makeSkill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    id: "local:test-skill",
    slug: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    source: "local",
    tags: [],
    scope: "seren",
    skillsDir: "/test/skills",
    dirName: "test-skill",
    path: "/test/skills/test-skill/SKILL.md",
    installedAt: Date.now(),
    enabled: true,
    contentHash: "abc123",
    ...overrides,
  };
}

const publisherSyncState: SkillSyncState = {
  version: 1,
  upstreamSource: "seren",
  upstreamSourceUrl:
    "https://api.serendb.com/publishers/polymarket-trading-serenai/skill.md",
  syncedRevision: null,
  syncedAt: Date.now(),
  managedFiles: { "SKILL.md": "abc123" },
};

const repoSyncState: SkillSyncState = {
  version: 1,
  upstreamSource: "serenorg",
  upstreamSourceUrl:
    "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket/bot/SKILL.md",
  syncedRevision: "abc123",
  syncedAt: Date.now(),
  managedFiles: { "SKILL.md": "abc123" },
};

describe("isPublisherManagedSkill", () => {
  it("returns true for a skill with seren publisher sync state", () => {
    const skill = makeSkill({
      syncState: publisherSyncState,
      upstreamSource: "seren",
      upstreamSourceUrl: publisherSyncState.upstreamSourceUrl,
    });
    expect(isPublisherManagedSkill(skill)).toBe(true);
  });

  it("returns false for a skill with serenorg upstream sync state", () => {
    const skill = makeSkill({
      syncState: repoSyncState,
      upstreamSource: "serenorg",
      upstreamSourceUrl: repoSyncState.upstreamSourceUrl,
    });
    expect(isPublisherManagedSkill(skill)).toBe(false);
  });

  it("returns false for a skill with no sync state", () => {
    const skill = makeSkill({ syncState: null });
    expect(isPublisherManagedSkill(skill)).toBe(false);
  });

  it("returns false for a skill with empty upstreamSourceUrl", () => {
    const skill = makeSkill({
      syncState: { ...publisherSyncState },
      upstreamSource: "seren",
      upstreamSourceUrl: "",
    });
    expect(isPublisherManagedSkill(skill)).toBe(false);
  });
});

describe("publisher slug extraction from upstreamSourceUrl", () => {
  it("extracts publisher slug from standard sourceUrl format", () => {
    const url =
      "https://api.serendb.com/publishers/polymarket-trading-serenai/skill.md";
    const match = url.match(/\/publishers\/([^/]+)\/skill\.md$/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("polymarket-trading-serenai");
  });

  it("returns null for non-publisher URLs", () => {
    const url =
      "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket/SKILL.md";
    const match = url.match(/\/publishers\/([^/]+)\/skill\.md$/);
    expect(match).toBeNull();
  });
});
