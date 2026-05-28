// ABOUTME: Critical guards for #2058 — fast mode is a gated Claude config
// ABOUTME: option that maps to the CLI's apply_flag_settings control request.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const {
  _buildSessionStatus: buildSessionStatus,
  _buildFastModeFlagSettings: buildFastModeFlagSettings,
} = await import(/* @vite-ignore */ modulePath);

function sessionWithFastSupport(supportsFastMode: boolean) {
  return {
    id: "session-1",
    status: "ready",
    agentSessionId: "agent-session-1",
    claudeVersion: "2.1.156",
    currentModelId: "default",
    currentModeId: "default",
    reasoningEffort: "medium",
    fastModeEnabled: false,
    availableModelRecords: [
      {
        modelId: "default",
        name: "Default",
        description: "Default model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsFastMode,
        supportsAutoMode: true,
        supportsAdaptiveThinking: true,
        isDefault: true,
      },
    ],
  };
}

describe("#2058 Claude fast mode config", () => {
  it("emits a fast_mode select option only for the selected fast-capable model", () => {
    const capableStatus = buildSessionStatus(sessionWithFastSupport(true));
    expect(
      capableStatus.configOptions?.find(
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

    const unsupportedStatus = buildSessionStatus(sessionWithFastSupport(false));
    expect(
      unsupportedStatus.configOptions?.some(
        (option: { id: string }) => option.id === "fast_mode",
      ),
    ).toBe(false);
  });

  it("does not fall back to the default model when currentModelId is unknown", () => {
    const status = buildSessionStatus({
      ...sessionWithFastSupport(true),
      currentModelId: "non-catalog-model",
    });

    expect(
      status.configOptions?.some(
        (option: { id: string }) => option.id === "fast_mode",
      ),
    ).toBe(false);
  });

  it("maps UI values to the apply_flag_settings fastMode payload", () => {
    expect(buildFastModeFlagSettings("on")).toEqual({ fastMode: true });
    expect(buildFastModeFlagSettings("off")).toEqual({ fastMode: null });
  });

  it("rejects unknown fast_mode values before they can reach the CLI", () => {
    expect(() => buildFastModeFlagSettings("enabled")).toThrow(
      "Unsupported fast mode value",
    );
  });
});
