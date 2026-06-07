// ABOUTME: Locks the #2103 carry-forward wiring in both chat and agent stores.
// ABOUTME: A second compaction must feed the prior summary into the iterative prompt.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatStore = readFileSync(resolve("src/stores/chat.store.ts"), "utf-8");
const agentStore = readFileSync(resolve("src/stores/agent.store.ts"), "utf-8");

describe("#2103 chat compaction carries the prior summary forward", () => {
  it("reads the existing compactedSummary content as previousSummary", () => {
    expect(chatStore).toContain(
      "const previousSummary = activeConvo?.compactedSummary?.content ?? null;",
    );
  });

  it("feeds previousSummary into the shared iterative prompt builder", () => {
    expect(chatStore).toContain("buildIterativeCompactionPrompt({");
    expect(chatStore).toContain('mode: "chat"');
  });

  it("records lineage from the prior lineage so generation increments", () => {
    expect(chatStore).toContain(
      "previousLineage: activeConvo?.compactedSummary?.lineage ?? null,",
    );
  });

  it("no longer asks the model to predict the next user ask", () => {
    expect(chatStore).not.toContain("what the user will likely ask next");
  });
});

describe("#2103 agent compaction carries the prior summary forward", () => {
  it("reads the serving session's compactedSummary content as previousSummary", () => {
    expect(agentStore).toContain(
      "const previousSummary = session.compactedSummary?.content ?? null;",
    );
  });

  it("feeds previousSummary into the shared iterative prompt builder", () => {
    expect(agentStore).toContain("buildIterativeCompactionPrompt({");
    expect(agentStore).toContain('mode: "agent"');
  });

  it("records lineage from the prior session lineage", () => {
    expect(agentStore).toContain(
      "previousLineage: session.compactedSummary?.lineage ?? null,",
    );
  });

  it("keeps the VERIFY-BEFORE-ACTING anti-fabrication banner", () => {
    expect(agentStore).toContain("VERIFY-BEFORE-ACTING:");
  });
});
