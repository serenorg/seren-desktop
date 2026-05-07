// ABOUTME: Regression tests for agent skill context priming and token dedupe.
// ABOUTME: Guards the source-level contract without constructing the large agent store.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  join(process.cwd(), "src/stores/agent.store.ts"),
  "utf8",
);

function methodBody(name: string): string {
  const start = agentStoreSource.indexOf(`${name}(`);
  expect(start).toBeGreaterThan(0);
  const nextMethod = agentStoreSource.indexOf("\n  },", start);
  expect(nextMethod).toBeGreaterThan(start);
  return agentStoreSource.slice(start, nextMethod);
}

describe("agent skill context priming", () => {
  it("signs the publisher instruction and resolved skill content", () => {
    const body = methodBody("async buildPromptContext");

    expect(body).toContain("skillsStore.getThreadSkillsContent");
    expect(body).toContain("PUBLISHER_LIVE_QUERY_INSTRUCTION");
    expect(body).toContain("const currentSignature");
    expect(body).toContain("primedContextSignature === currentSignature");
  });

  it("re-primes after the defensive message threshold", () => {
    const body = methodBody("async buildPromptContext");

    expect(agentStoreSource).toContain("const REPRIME_AFTER_MESSAGES = 30");
    expect(body).toContain("messagesSincePrimed > REPRIME_AFTER_MESSAGES");
    expect(body).toContain("!expired &&");
  });

  it("only records the primed signature after a successful provider send", () => {
    const sendPromptBody = methodBody("async sendPrompt");
    const firstSend = sendPromptBody.indexOf(
      "await providerService.sendPrompt(sessionId, dispatchedPrompt, merged)",
    );
    const firstMark = sendPromptBody.indexOf(
      "this.markPromptContextPrimed(sessionId, newSignature)",
    );
    const retrySend = sendPromptBody.indexOf(
      "await providerService.sendPrompt(\n                  newSessionId,",
    );
    const retryMark = sendPromptBody.indexOf(
      "this.markPromptContextPrimed(newSessionId, newSignature)",
    );

    expect(firstSend).toBeGreaterThan(0);
    expect(firstMark).toBeGreaterThan(firstSend);
    expect(retrySend).toBeGreaterThan(0);
    expect(retryMark).toBeGreaterThan(retrySend);
  });
});
