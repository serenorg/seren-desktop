// ABOUTME: Critical tests for #1635 — message.model as ground truth for session.currentModelId.
// ABOUTME: Guards the picker/reality sync so the UI stops lying about which model is live.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/model-resolution.mjs",
  import.meta.url,
).href;
const { chooseUpdatedModelId, inferCurrentModelId } = await import(
  /* @vite-ignore */ modulePath
);

const records = [
  { modelId: "claude-opus-4-5" },
  { modelId: "claude-opus-4-6" },
  { modelId: "claude-opus-4-7" },
  { modelId: "claude-sonnet-4-6" },
];

describe("chooseUpdatedModelId (#1635)", () => {
  it("returns the incoming model when it differs from the current one — the picker lied about 4.6 but CLI is on 4.5", () => {
    expect(
      chooseUpdatedModelId("claude-opus-4-6", "claude-opus-4-5", records),
    ).toBe("claude-opus-4-5");
  });

  it("returns null when message.model is empty or missing so we don't churn session-status events", () => {
    expect(chooseUpdatedModelId("claude-opus-4-5", "", records)).toBeNull();
    expect(
      chooseUpdatedModelId("claude-opus-4-5", undefined as unknown as string, records),
    ).toBeNull();
    expect(
      chooseUpdatedModelId("claude-opus-4-5", null as unknown as string, records),
    ).toBeNull();
  });

  it("accepts an unrecognized model id rather than forcing a catalog match — unknown truth is still truth", () => {
    // CLI reports a model Seren's catalog doesn't know yet (e.g. Opus 4.8
    // shipped today). We must surface it, not silently remap to whatever
    // looks closest and let the UI go stale.
    expect(
      chooseUpdatedModelId("claude-opus-4-5", "claude-opus-4-8", records),
    ).toBe("claude-opus-4-8");
  });

  it("returns the matched catalog id when message.model matches exactly", () => {
    expect(
      chooseUpdatedModelId("claude-opus-4-5", "claude-opus-4-6", records),
    ).toBe("claude-opus-4-6");
  });

  it("rejects sentinel-bracketed placeholders so CLI-fabricated turns can't poison currentModelId", () => {
    // Repro for the stream-idle-timeout regression: Claude Code emits a
    // synthesized assistant turn with `message.model = "<synthetic>"` after
    // a partial-response timeout. Without this guard, `<synthetic>` flows
    // into `session.currentModelId` and the next `--model` spawn arg, which
    // the CLI hard-rejects ("issue with the selected model (<synthetic>)").
    expect(
      chooseUpdatedModelId("claude-opus-4-7", "<synthetic>", records),
    ).toBeNull();
  });
});

describe("inferCurrentModelId fuzzy tiers", () => {
  it("maps a bare 'opus' hint to a concrete Opus record when no exact match exists", () => {
    expect(inferCurrentModelId("opus", records)).toMatch(/^claude-opus/);
  });

  it("returns null for empty records", () => {
    expect(inferCurrentModelId("claude-opus-4-5", [])).toBeNull();
  });
});
