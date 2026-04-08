// ABOUTME: Regression guard for #1482 — Enable Web Search must default to ON.
// ABOUTME: Fresh installs shipped with web-search disabled, silently degrading every new session.

import { describe, expect, it, vi } from "vitest";

// Mock Tauri bridge before importing the store so settings init runs in browser fallback mode.
vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => false,
}));

import { settingsStore } from "@/stores/settings.store";

describe("settings defaults — #1482 web-search regression guard", () => {
  it("agentSearchEnabled defaults to true so fresh installs can browse the web", () => {
    // If this flips back to false, every new install ships with the agent
    // unable to use the web-search tool until the user manually finds the
    // toggle under Settings → Agent. That is the bug #1482 fixed.
    expect(settingsStore.getDefault("agentSearchEnabled")).toBe(true);
  });
});
