// ABOUTME: Critical guard for #1800 — the compaction summary template must
// ABOUTME: separate done-vs-discussed AND the post-generation banner must travel with `summary` so both consumer paths inherit it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIterativeCompactionPrompt } from "@/lib/compaction/summary";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

// Post-#2103 the agent summary template lives in the shared compaction helper
// rather than inline in agent.store.ts. Assert the anti-fabrication contract
// against the actual built prompt — stronger than the old source-grep, since
// it survives further relocation as long as the behavior holds.
const agentPrompt = buildIterativeCompactionPrompt({
  previousSummary: null,
  newTurns: "USER: do the thing\n\nASSISTANT: ok",
  mode: "agent",
});

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

  it("buckets completion evidence into a COMPLETED field that requires a verifiable artifact path/table", () => {
    // The COMPLETED field must require a verifiable artifact — not just a
    // freeform claim. If a future edit relaxes the format clause back to
    // e.g. `COMPLETED: <items completed>`, the gauge regresses.
    expect(agentPrompt).toMatch(
      /COMPLETED:\s*<only actions with an explicit verifiable artifact/,
    );
    expect(agentPrompt).toMatch(/path or db\.table/);
    // The bare `STATE:` field that invited the failure mode must not come
    // back. Match the exact pre-#1800 shape so legitimate future field
    // names containing "STATE" are not false-positives.
    expect(agentPrompt).not.toMatch(/STATE:\s*<what is done vs in progress>/);
  });

  it("keeps a distinct IN_PROGRESS bucket so discussed-but-not-done work cannot masquerade as completed", () => {
    expect(agentPrompt).toMatch(/IN_PROGRESS:/);
    // The pre-#1800 unconstrained `FILES: <files created or modified` line
    // must not be reintroduced.
    expect(agentPrompt).not.toMatch(/FILES:\s*<files created or modified/);
  });

  it("instructs the model to write 'none' for empty fields instead of fabricating to fill the shape", () => {
    // Without this instruction the model fills empty fields with
    // confabulations to satisfy the template shape — which is exactly how
    // a session that had done nothing produced "Day 1 complete" in #1797.
    expect(agentPrompt).toMatch(
      /If a field has nothing to report, write 'none' — DO NOT invent content/,
    );
  });

  it("verify-before-acting banner is appended to `summary` BEFORE assignment to compactedSummary, so both seed-prompt and synthetic-transcript paths inherit it", () => {
    // Both consumer paths read `summary` after this point: the seed prompt
    // embeds it as `${summary}` (consumed by the legacy predictive and
    // reactive respawn paths), and `buildSyntheticTranscript()` receives it
    // as the third arg (the default for claude-code agents). Mutating
    // `summary` itself is the only single-edit position that covers both —
    // a banner placed only on seedPrompt would miss the synthetic path. This
    // test pins both the banner content and its position relative to the
    // `compactedSummary` assignment.
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
