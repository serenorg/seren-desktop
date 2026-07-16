// ABOUTME: Critical guards for Codex reasoning and Fast service-tier defaults.
// ABOUTME: Keeps #2957 direct-spawn defaults isolated from paired executor behavior.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/providers.mjs",
  import.meta.url,
).href;
const {
  _buildCodexSessionStatus: buildCodexSessionStatus,
  _buildCodexThreadStartParams: buildCodexThreadStartParams,
  _buildCodexTurnStartParams: buildCodexTurnStartParams,
  _codexServiceTierFromFastModeValue: codexServiceTierFromFastModeValue,
  _normalizeCodexModelRecords: normalizeCodexModelRecords,
  _resolveCodexInitialReasoningEffort: resolveCodexInitialReasoningEffort,
  _resolveCodexInitialServiceTier: resolveCodexInitialServiceTier,
  _resolveCodexPreferredModelRecord: resolveCodexPreferredModelRecord,
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

describe("#2890 Codex GPT-5.6 defaults", () => {
  it("prefers GPT-5.6 Sol for direct Codex even when model/list is stale", () => {
    const records = normalizeCodexModelRecords(modelListResult());
    const preferred = resolveCodexPreferredModelRecord(records, {
      intent: "direct",
    });

    expect(preferred?.modelId).toBe("gpt-5.6-sol");
    expect(preferred?.name).toBe("GPT-5.6 Sol");
    expect(
      resolveCodexInitialReasoningEffort(preferred, { intent: "direct" }),
    ).toBe("xhigh");
  });

  it("prefers GPT-5.6 Luna with low effort for the paired Claude + Codex executor even when model/list is stale", () => {
    const records = normalizeCodexModelRecords(modelListResult());
    const preferred = resolveCodexPreferredModelRecord(records, {
      intent: "paired-executor",
    });

    expect(preferred?.modelId).toBe("gpt-5.6-luna");
    expect(preferred?.name).toBe("GPT-5.6 Luna");
    expect(
      resolveCodexInitialReasoningEffort(preferred, {
        intent: "paired-executor",
      }),
    ).toBe("low");
  });

  it("preserves an explicit Codex model over preferred defaults", () => {
    const records = normalizeCodexModelRecords(modelListResult());
    const preferred = resolveCodexPreferredModelRecord(records, {
      intent: "direct",
      explicitModelId: "gpt-5.6-luna",
    });

    expect(preferred?.modelId).toBe("gpt-5.6-luna");
  });

  it("passes the resolved model to Codex thread/start", () => {
    const params = buildCodexThreadStartParams(
      session({ currentModelId: "gpt-5.6-sol" }),
      "/repo",
      "auto",
      "danger-full-access",
    );

    expect(params).toMatchObject({
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-5.6-sol",
    });
  });
});

describe("#2957 direct Codex spawn defaults", () => {
  it("selects xhigh and Fast for direct sessions without changing paired defaults", () => {
    const baseModel = session().availableModelRecords[0];
    const model = {
      ...baseModel,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { value: "low", name: "low" },
        ...baseModel.supportedReasoningEfforts,
        { value: "xhigh", name: "xhigh" },
      ],
    };

    expect(
      resolveCodexInitialReasoningEffort(model, { intent: "direct" }),
    ).toBe("xhigh");
    expect(
      resolveCodexInitialServiceTier(model, { intent: "direct" }),
    ).toBe("fast");

    const directSession = session({
      availableModelRecords: [model],
      currentModelId: model.modelId,
      reasoningEffort: "xhigh",
      serviceTier: "fast",
    });
    expect(
      buildCodexThreadStartParams(
        directSession,
        "/repo",
        "auto",
        "danger-full-access",
      ),
    ).toMatchObject({ serviceTier: "fast" });
    expect(buildCodexSessionStatus(directSession).configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reasoning_effort",
          currentValue: "xhigh",
        }),
        expect.objectContaining({ id: "fast_mode", currentValue: "on" }),
      ]),
    );

    expect(
      resolveCodexInitialReasoningEffort(model, {
        intent: "paired-executor",
      }),
    ).toBe("low");
    expect(
      resolveCodexInitialServiceTier(model, {
        intent: "paired-executor",
      }),
    ).toBeNull();

    const unsupportedModel = session().availableModelRecords[1];
    expect(
      resolveCodexInitialReasoningEffort(unsupportedModel, {
        intent: "direct",
      }),
    ).toBe("medium");
    expect(
      resolveCodexInitialServiceTier(unsupportedModel, { intent: "direct" }),
    ).toBeNull();
  });
});

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
