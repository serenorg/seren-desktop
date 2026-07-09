// ABOUTME: Critical guards for #2888 — Codex Fast Mode maps to app-server serviceTier.
// ABOUTME: Keeps model service-tier metadata, config options, and turn payloads wired.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/providers.mjs",
  import.meta.url,
).href;
const {
  _buildCodexSessionStatus: buildCodexSessionStatus,
  _buildCodexTurnStartParams: buildCodexTurnStartParams,
  _codexServiceTierFromFastModeValue: codexServiceTierFromFastModeValue,
  _normalizeCodexModelRecords: normalizeCodexModelRecords,
} = await import(/* @vite-ignore */ modulePath);

function modelListResult() {
  return {
    data: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Full Codex model",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "More depth" },
        ],
        defaultServiceTier: null,
        serviceTiers: [
          {
            id: "priority",
            name: "Fast",
            description: "Higher-throughput Fast tier",
          },
        ],
        additionalSpeedTiers: ["fast"],
        isDefault: true,
      },
      {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        description: "Mini model",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [],
        defaultServiceTier: null,
        serviceTiers: [],
        isDefault: false,
      },
    ],
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    status: "ready",
    agentSessionId: "thread-1",
    availableModelRecords: normalizeCodexModelRecords(modelListResult()),
    currentModelId: "gpt-5.5",
    currentModeId: "auto",
    reasoningEffort: "medium",
    serviceTier: null,
    ...overrides,
  };
}

describe("#2888 Codex fast mode config", () => {
  it("exposes Fast support from Codex service-tier metadata and emits a fast_mode option", () => {
    const status = buildCodexSessionStatus(session());

    expect(status.models.availableModels[0]).toMatchObject({
      modelId: "gpt-5.5",
      supportsFastMode: true,
    });
    expect(status.models.availableModels[1]).toMatchObject({
      modelId: "gpt-5.4-mini",
      supportsFastMode: false,
    });
    expect(
      status.configOptions.find(
        (option: { id: string }) => option.id === "fast_mode",
      ),
    ).toMatchObject({
      id: "fast_mode",
      type: "select",
      currentValue: "off",
      options: [
        { value: "on", name: "On" },
        { value: "off", name: "Off" },
      ],
    });
  });

  it("hides fast_mode for a Codex model without a Fast service tier", () => {
    const status = buildCodexSessionStatus(
      session({ currentModelId: "gpt-5.4-mini" }),
    );

    expect(
      status.configOptions.some(
        (option: { id: string }) => option.id === "fast_mode",
      ),
    ).toBe(false);
  });

  it("maps fast_mode values to app-server serviceTier values", () => {
    expect(codexServiceTierFromFastModeValue("on", session())).toBe("fast");
    expect(codexServiceTierFromFastModeValue("off", session())).toBeNull();
    expect(() =>
      codexServiceTierFromFastModeValue("enabled", session()),
    ).toThrow("Unsupported fast mode value");
  });

  it("adds serviceTier to future Codex turn/start params when Fast is selected", () => {
    const params = buildCodexTurnStartParams(
      session({ serviceTier: "fast" }),
      "hello",
      [],
    );

    expect(params).toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.5",
      effort: "medium",
      serviceTier: "fast",
    });
  });
});
