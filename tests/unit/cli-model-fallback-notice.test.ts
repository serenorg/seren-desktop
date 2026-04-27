// ABOUTME: Source-level regression tests for #1678 — surface CLI silent
// ABOUTME: model fallback to the picker without removing legacy Opus entries.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const selectorSource = readFileSync(
  resolve("src/components/chat/AgentModelSelector.tsx"),
  "utf-8",
);

describe("#1678 Option B — CLI silent fallback surfaces to the picker", () => {
  it("ActiveSession carries userSelectedModelId (intent) and modelFallbackNotice (divergence)", () => {
    // userSelectedModelId persists past pendingModelId's clear-on-ack so we
    // can keep comparing against the user's last clicked id even after the
    // setModel ack has matched the request.
    expect(agentStoreSource).toMatch(/userSelectedModelId\?:\s*string/);
    // The divergence record carries both ids so the UI can show the gap
    // verbatim ("requested X, CLI is running Y").
    expect(agentStoreSource).toMatch(
      /modelFallbackNotice\?:\s*\{\s*requested:\s*string;\s*actual:\s*string\s*\}\s*\|\s*null/,
    );
  });

  it("setModel records the user's intent in userSelectedModelId before the IPC call", () => {
    // Without this, a follow-up message.model that disagrees with the user's
    // last click is indistinguishable from an externally-driven model change.
    const idx = agentStoreSource.indexOf("async setModel(");
    expect(idx).toBeGreaterThan(0);
    const region = agentStoreSource.slice(idx, idx + 2000);
    expect(region).toMatch(
      /setState\("sessions",\s*sessionId,\s*"userSelectedModelId",\s*modelId\)/,
    );
  });

  it("sessionStatus handler records modelFallbackNotice when CLI's model diverges from user's selection", () => {
    // After the pending guard at line ~5118, if the user picked something
    // (userSelectedModelId set, no pending) and the runtime is reporting a
    // different actual currentModelId, write a notice so the picker can
    // surface it. Clears when they line up again.
    const idx = agentStoreSource.indexOf("pending === models.currentModelId");
    expect(idx).toBeGreaterThan(0);
    const region = agentStoreSource.slice(idx, idx + 2500);
    expect(region).toMatch(/userSelectedModelId/);
    expect(region).toMatch(/modelFallbackNotice/);
    // Must store both the requested (user intent) and actual (CLI ground
    // truth) — verify the notice payload references the userSelected source
    // and the runtime's actual currentModelId.
    expect(region).toMatch(/requested:\s*userSelected/);
    expect(region).toMatch(/actual:\s*models\.currentModelId/);
  });

  it("AgentModelSelector renders the divergence indicator next to the picker", () => {
    // Picker must read the notice off the session and surface it. We don't
    // pin a specific glyph — just that the notice is visible somehow.
    expect(selectorSource).toMatch(/modelFallbackNotice/);
  });
});
