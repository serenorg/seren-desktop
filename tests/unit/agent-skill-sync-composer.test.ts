// ABOUTME: Guards #2649 — agent chat must surface skill sync actions like Seren chat.
// ABOUTME: Source-level because mounting AgentChat requires the full agent runtime harness.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

describe("agent chat skill sync composer affordance (#2649)", () => {
  it("loads recent skill sync status without opening the Skills panel", () => {
    expect(agentChatSource).toContain("skillsStore.loadSyncStatus(skill)");
    expect(agentChatSource).toContain("skillsStore.syncStatusFor(skill.path)");
  });

  it("renders the shared SyncSkillButton and sync action for stale recent skills", () => {
    expect(agentChatSource).toContain("SyncSkillButton");
    expect(agentChatSource).toContain("activeSkillNeedsSync() && recentSkill()");
    expect(agentChatSource).toContain("skillsStore.syncInstalledSkill(skill)");
  });
});
