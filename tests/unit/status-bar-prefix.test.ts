// ABOUTME: Regression guard for #1669 — StatusBar must NOT hardcode "Codex:" as the running tool prefix.
// ABOUTME: The prefix has to come from the active agent's display name so Claude/Gemini threads don't show "Codex:".

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const statusBarSource = readFileSync(
  resolve("src/components/common/StatusBar.tsx"),
  "utf-8",
);
const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1669 — StatusBar agent prefix", () => {
  it('does NOT hardcode "Codex: " as the running tool prefix', () => {
    expect(statusBarSource).not.toContain("`Codex: ${");
    expect(statusBarSource).not.toMatch(/["']Codex: ["']/);
  });

  it("derives the prefix from agentDisplayName so Claude / Codex / Gemini sessions all get the right label", () => {
    expect(statusBarSource).toContain("agentDisplayName");
    expect(statusBarSource).toContain("session.info.agentType");
  });

  it("agentDisplayName is exported from agent.store so StatusBar can import it", () => {
    expect(agentStoreSource).toContain("export function agentDisplayName");
  });
});
