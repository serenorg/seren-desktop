// ABOUTME: Critical guard for #1800 — the compaction summary template must
// ABOUTME: separate done-vs-discussed AND the post-generation banner must travel with `summary` so both consumer paths inherit it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

// Slice the agent.store source forward from a fixed anchor and return a
// window large enough to contain the compactAgentConversation body.
function regionAfter(anchor: string, len = 4000): string {
  const idx = agentStoreSource.indexOf(anchor);
  if (idx < 0) {
    throw new Error(`anchor not found in agent.store.ts: ${anchor}`);
  }
  return agentStoreSource.slice(idx, idx + len);
}

describe("#1800 — compaction summary cannot fabricate completed state", () => {
  // Pre-#1800: the template carried `STATE: <what is done vs in progress>`
  // and `FILES: <files created or modified>` with no evidence constraint.
  // The Sonnet 4 summarizer collapsed intent expressed during the
  // conversation into claims about completed artifacts on disk — observed
  // in #1797 where a session that had only DISCUSSED Day 1 work produced
  // "Day 1 complete - tracking infrastructure ready, 12 YouTube URLs
  // approved, yt-dlp installed, bad synthetic data purged" along with
  // FILES: paths to a journal and SerenDB project that did not exist.
  // The post-compaction agent then trusted the summary, skipped
  // re-verification, and started spending against external paid services
  // on the assumption that prerequisite artifacts already existed.

  it("template buckets state into DONE and DISCUSSED_NOT_DONE with explicit artifact-path requirement", () => {
    const region = regionAfter("async compactAgentConversation(", 6000);
    // The two new evidence-bucketed fields must both be present.
    expect(region).toMatch(/DONE:/);
    expect(region).toMatch(/DISCUSSED_NOT_DONE:/);
    // The DONE: field must require a verifiable artifact path/table — not
    // just a freeform claim. If a future edit relaxes the format clause
    // back to e.g. `DONE: <items completed>`, the gauge regresses.
    expect(region).toMatch(
      /DONE:\s*<only items with explicit verifiable artifacts/,
    );
    // The bare `STATE:` field that invited the failure mode must not
    // come back. We match the exact pre-#1800 shape so that legitimate
    // future field names containing "STATE" (e.g. AGENT_STATE) are not
    // false-positives.
    expect(region).not.toMatch(/STATE:\s*<what is done vs in progress>/);
  });

  it("template buckets file mentions into FILES_TOUCHED with a tool-call evidence constraint", () => {
    const region = regionAfter("async compactAgentConversation(", 6000);
    // FILES_TOUCHED must explicitly tie its scope to tool calls executed
    // in the conversation, not the looser pre-#1800 wording that allowed
    // the model to count "discussed" or "proposed" files as touched.
    expect(region).toMatch(
      /FILES_TOUCHED:\s*<files actually created or modified by tool calls/,
    );
    // The pre-#1800 unconstrained `FILES: <files created or modified` line
    // must not be reintroduced.
    expect(region).not.toMatch(/FILES:\s*<files created or modified/);
  });

  it("template instructs the model to write 'none' for empty fields instead of fabricating to fill the shape", () => {
    // Without this instruction the model fills empty fields with
    // confabulations to satisfy the template shape — which is exactly
    // how a session that had done nothing produced "Day 1 complete" in
    // the #1797 repro.
    const region = regionAfter("async compactAgentConversation(", 6000);
    expect(region).toMatch(
      /If a field has nothing to report, write 'none' — DO NOT invent content/,
    );
  });

  it("verify-before-acting banner is appended to `summary` BEFORE assignment to compactedSummary, so both seed-prompt and synthetic-transcript paths inherit it", () => {
    // Both consumer paths read `summary` after this point: the seed
    // prompt embeds it as `${summary}` (consumed by the legacy predictive
    // and reactive respawn paths), and `buildSyntheticTranscript()`
    // receives it as the third arg (consumed by the synthetic-transcript
    // path that is the default for claude-code agents). Mutating
    // `summary` itself is the only single-edit position that covers both
    // — a banner placed only on seedPrompt would miss the synthetic path
    // entirely. This test pins both the banner content and its position
    // relative to the `compactedSummary` assignment.
    const idx = agentStoreSource.indexOf(
      "const compactedSummary: AgentCompactedSummary = {",
    );
    expect(idx).toBeGreaterThan(0);
    // Window backwards from the assignment to find the banner write.
    const preceding = agentStoreSource.slice(Math.max(0, idx - 1500), idx);
    expect(preceding).toMatch(/summary\s*=\s*`\$\{summary\.trim\(\)\}/);
    expect(preceding).toMatch(/VERIFY-BEFORE-ACTING:/);
    expect(preceding).toMatch(
      /may not exist on disk[\s\S]{0,200}before acting on any claim/,
    );
  });
});
