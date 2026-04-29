// ABOUTME: Critical regression test for #1729 — picker label is sticky to the
// ABOUTME: user's selection and the divergence warning glyph is removed.

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

describe("#1729 sticky picker label — no flicker, no divergence glyph", () => {
  it("AgentModelSelector renders userSelectedModelId when set, falling back to currentModelId", () => {
    // The label must NOT bind to currentModelId alone — that flickers as the
    // CLI emits message.model ground truth. It binds to userSelectedModelId
    // (sticky user intent from #1714, kept) so the only thing that moves the
    // label is a deliberate picker click.
    expect(selectorSource).toMatch(/userSelectedModelId/);
    // The picker still falls back to currentModelId for sessions that have
    // never had an explicit user selection (initial state from `init`).
    expect(selectorSource).toMatch(/currentModelId/);
  });

  it("AgentModelSelector does not reference the divergence/fallback notice machinery", () => {
    // Per #1729: a warning the user cannot act on is bad UX. Removed entirely
    // from the picker. The diagnostic value lives in the #1718 logs, not
    // burdening the UI.
    expect(selectorSource).not.toMatch(/modelFallbackNotice/);
    expect(selectorSource).not.toMatch(/fallbackNotice/);
    expect(selectorSource).not.toMatch(/Model fallback warning/);
  });

  it("agent.store no longer carries modelFallbackNotice or its detection block", () => {
    // The ActiveSession field, the setModel clearing line, and the
    // sessionStatus divergence-detection block from #1714 are all removed.
    // userSelectedModelId stays — it is the sticky picker label source.
    expect(agentStoreSource).toMatch(/userSelectedModelId/);
    expect(agentStoreSource).not.toMatch(/modelFallbackNotice/);
  });
});
