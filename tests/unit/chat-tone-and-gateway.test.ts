// ABOUTME: Regression guards for serenorg/seren-desktop#1464 — chat assistant
// ABOUTME: must inject tone rules and must not race the MCP gateway init.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatSource = readFileSync(resolve("src/services/chat.ts"), "utf-8");
const gatewaySource = readFileSync(
  resolve("src/services/mcp-gateway.ts"),
  "utf-8",
);
const rustSource = readFileSync(
  resolve("src-tauri/src/orchestrator/chat_model_worker.rs"),
  "utf-8",
);

describe("tone instructions (#1464)", () => {
  it("JS path exports a TONE_INSTRUCTIONS constant", () => {
    // Single source of truth for the JS direct-provider system prompt.
    expect(chatSource).toMatch(/export const TONE_INSTRUCTIONS\s*=/);
  });

  it("JS tone block forbids sycophantic openers and emoji", () => {
    expect(chatSource).toContain("Be concise. Lead with the answer");
    expect(chatSource).toContain("Never open with");
    expect(chatSource).toContain("Do not use emojis");
    expect(chatSource).toContain(
      "Never claim a tool or capability is unavailable without first checking",
    );
  });

  it("JS path appends TONE_INSTRUCTIONS to systemContent", () => {
    // The constant must actually be injected into the prompt, not merely
    // declared. Catches the case where someone removes the append.
    expect(chatSource).toMatch(/systemContent\s*\+=\s*TONE_INSTRUCTIONS/);
  });

  it("Rust path defines a matching TONE_INSTRUCTIONS constant", () => {
    expect(rustSource).toContain("const TONE_INSTRUCTIONS");
    expect(rustSource).toContain("Be concise. Lead with the answer");
    expect(rustSource).toContain("Never open with");
    expect(rustSource).toContain("Do not use emojis");
    expect(rustSource).toContain(
      "Never claim a tool or capability is unavailable without first checking",
    );
  });

  it("Rust path pushes TONE_INSTRUCTIONS into system_parts", () => {
    expect(rustSource).toContain("system_parts.push(TONE_INSTRUCTIONS");
  });
});

describe("MCP gateway readiness wait (#1464)", () => {
  it("mcp-gateway exports waitForGatewayReady with a bounded timeout", () => {
    expect(gatewaySource).toMatch(
      /export async function waitForGatewayReady\(\s*timeoutMs:\s*number/,
    );
  });

  it("mcp-gateway exports isGatewayInitInFlight introspection helper", () => {
    expect(gatewaySource).toMatch(
      /export function isGatewayInitInFlight\(\)/,
    );
  });

  it("waitForGatewayReady races initializeGateway against the timeout", () => {
    // Must not block the chat indefinitely — Promise.race or equivalent.
    expect(gatewaySource).toContain("Promise.race");
    expect(gatewaySource).toContain("initializeGateway()");
  });

  it("chat.ts awaits gateway readiness before building publisher context", () => {
    // The await must come BEFORE buildPublishersContext is called, otherwise
    // the cache is read while still empty on the first message after login.
    const idxAwait = chatSource.indexOf("await waitForGatewayReady(");
    const idxBuild = chatSource.indexOf("const buildPublishersContext");
    expect(idxAwait).toBeGreaterThan(-1);
    expect(idxBuild).toBeGreaterThan(-1);
    expect(idxAwait).toBeLessThan(idxBuild);
  });
});

describe("honest fallback when gateway not ready (#1464)", () => {
  it("buildPublishersContext returns 'still initializing' message instead of empty string when init in flight", () => {
    // This is the belt-and-suspenders branch: if waitForGatewayReady times
    // out or the user sends a message before init even starts, the system
    // prompt must NOT be silent about Seren tools — it must explicitly tell
    // the model to say tools are loading rather than denying access.
    expect(chatSource).toContain("isGatewayInitInFlight");
    expect(chatSource).toContain(
      "Do NOT claim that Seren publishers or tools are unavailable",
    );
    expect(chatSource).toMatch(/still initializing or temporarily unreachable/);
  });
});
