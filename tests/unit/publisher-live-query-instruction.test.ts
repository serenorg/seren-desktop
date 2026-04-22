// ABOUTME: Regression test for #1622 — the agent system-prompt instruction
// ABOUTME: must force a live list_agent_publishers query, never embed a stale snapshot.

import { describe, expect, it } from "vitest";
import { PUBLISHER_LIVE_QUERY_INSTRUCTION } from "@/stores/agent.store";

describe("#1622 — PUBLISHER_LIVE_QUERY_INSTRUCTION", () => {
  it("does not embed any publisher slug or comma-separated list", () => {
    // The bug was: agent.store.ts inlined `cachedPublisherSlugs.sort().join(", ")`.
    // If a contributor regresses by reintroducing that pattern, the instruction
    // will contain comma-separated slug-looking tokens. Guard against any slug
    // we know is common in Seren's catalog appearing alongside its siblings.
    const txt = PUBLISHER_LIVE_QUERY_INSTRUCTION;

    // These slug patterns must NEVER appear as a comma-joined list in the
    // instruction body — they are enumerated examples only in prose form.
    // A regression would look like "google-docs, google-drive, gmail, ..."
    // (the exact shape of the old snapshot). We reject any dash-slug that is
    // immediately followed by ", " and another dash-slug.
    const slugListPattern = /[a-z]+-[a-z]+,\s[a-z]+-[a-z]+/;
    expect(
      txt,
      "Instruction must not contain a comma-joined dash-slug list (stale snapshot signature)",
    ).not.toMatch(slugListPattern);
  });

  it("forces the agent to call list_agent_publishers live before refusing", () => {
    const txt = PUBLISHER_LIVE_QUERY_INSTRUCTION;
    // Must mention the tool name — that's how the agent knows what to call.
    expect(txt).toContain("list_agent_publishers");
    // Must state the rule as a MUST, not a suggestion, and must call out
    // the staleness of any prior belief — without these the model has
    // discretion and will revert to "I don't have that tool" on low confidence.
    expect(txt).toContain("MUST call");
    expect(txt.toLowerCase()).toContain("stale");
  });

  it("mentions call_publisher so the agent can invoke after discovery", () => {
    expect(PUBLISHER_LIVE_QUERY_INSTRUCTION).toContain("call_publisher");
  });
});
