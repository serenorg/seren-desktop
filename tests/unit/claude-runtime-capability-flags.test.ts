// ABOUTME: Critical guards for #2058 — Claude CLI model capability flags must
// ABOUTME: survive runtime normalization and session-status projection.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const {
  _normalizeModelRecords: normalizeModelRecords,
  _buildSessionStatus: buildSessionStatus,
  _augmentWithLegacyOpus: augmentWithLegacyOpus,
} = await import(/* @vite-ignore */ modulePath);

describe("#2058 Claude model capability flags", () => {
  it("preserves live initialize model flags through session status availableModels", () => {
    const records = normalizeModelRecords({
      models: [
        {
          value: "default",
          displayName: "Default (recommended)",
          description: "Opus 4.8 with 1M context",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          supportsFastMode: true,
          supportsAutoMode: true,
          supportsAdaptiveThinking: true,
        },
      ],
    });

    const status = buildSessionStatus({
      id: "session-1",
      status: "ready",
      agentSessionId: "agent-session-1",
      claudeVersion: "2.1.156",
      availableModelRecords: records,
      currentModelId: "default",
      currentModeId: "default",
      reasoningEffort: "medium",
      fastModeEnabled: false,
    });

    expect(status.models?.availableModels).toEqual([
      {
        modelId: "default",
        name: "Default (recommended)",
        description: "Opus 4.8 with 1M context",
        supportsFastMode: true,
        supportsAutoMode: true,
        supportsAdaptiveThinking: true,
      },
    ]);
  });

  it("defaults synthetic picker entries to no capability flags", () => {
    const augmented = augmentWithLegacyOpus([
      {
        modelId: "claude-opus-4-7",
        name: "Opus 4.7",
        description: "Opus 4.7",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsFastMode: true,
        supportsAutoMode: true,
        supportsAdaptiveThinking: true,
        isDefault: true,
      },
    ]) as Array<{
      modelId: string;
      supportsFastMode?: boolean;
      supportsAutoMode?: boolean;
      supportsAdaptiveThinking?: boolean;
    }>;

    const synthetic = augmented.find(
      (record) => record.modelId === "claude-opus-4-6",
    );
    expect(synthetic).toMatchObject({
      supportsFastMode: false,
      supportsAutoMode: false,
      supportsAdaptiveThinking: false,
    });
  });
});
