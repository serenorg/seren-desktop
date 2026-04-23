// ABOUTME: Source-level regression test for #1631 — idle-reclaim must not
// ABOUTME: terminate a warm standby session as a "competing instance."

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1631 — Claude idle-reclaim bypass for standby sessions", () => {
  it("ActiveSession type declares role: 'serving' | 'standby'", () => {
    expect(agentStoreSource).toMatch(
      /role:\s*"serving"\s*\|\s*"standby"/,
    );
  });

  it("getIdleClaudeSessionIds skips role === 'standby' sessions", () => {
    const idx = agentStoreSource.indexOf("function getIdleClaudeSessionIds");
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 1000);
    expect(body).toContain('session.role === "standby"');
  });

  it("spawnSession opts exposes role: 'serving' | 'standby'", () => {
    const idx = agentStoreSource.indexOf("async spawnSession(");
    expect(idx).toBeGreaterThan(0);
    const window = agentStoreSource.slice(idx, idx + 2500);
    expect(window).toMatch(
      /role\?:\s*"serving"\s*\|\s*"standby"/,
    );
  });

  it("new session construction sets role from opts, defaulting to 'serving'", () => {
    expect(agentStoreSource).toContain('role: opts?.role ?? "serving"');
  });
});
