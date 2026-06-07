// ABOUTME: Regression tests for agent skill context priming and token dedupe.
// ABOUTME: Guards the source-level contract without constructing the large agent store.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";

const agentStoreSource = readSource("src/stores/agent.store.ts");

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
    const recoverDroppedPromptBody = methodBody("async recoverDroppedPrompt");
    const firstSend = sendPromptBody.indexOf(
      "await providerService.sendPrompt(sessionId, dispatchedPrompt, merged)",
    );
    const firstMark = sendPromptBody.indexOf(
      "this.markPromptContextPrimed(sessionId, newSignature)",
    );
    const retrySend = recoverDroppedPromptBody.indexOf(
      "await providerService.sendPrompt(\n          newSessionId,",
    );
    const retryMark = recoverDroppedPromptBody.indexOf(
      "this.markPromptContextPrimed(newSessionId, newSignature)",
    );

    expect(firstSend).toBeGreaterThan(0);
    expect(firstMark).toBeGreaterThan(firstSend);
    expect(retrySend).toBeGreaterThan(0);
    expect(retryMark).toBeGreaterThan(retrySend);
  });

  it("#1960 budgets full skill priming before dispatch and falls back to a compact manifest", () => {
    const body = methodBody("async buildPromptContext");

    expect(body).toContain("estimatePromptContextTokens");
    expect(body).toContain("PROMPT_PRIMING_CONTEXT_BUDGET_FRACTION");
    expect(body).toContain("projectedFullPrimingTokens");
    expect(body).toContain('mode: "compact"');
    expect(body).toContain("deliveredSkillsContent");
  });

  it("#1960 keeps full skill content in the signature even when compact content is delivered", () => {
    const body = methodBody("async buildPromptContext");

    const signatureIdx = body.indexOf("const currentSignature");
    const compactIdx = body.indexOf('mode: "compact"');
    const returnIdx = body.indexOf("newSignature: alreadyPrimed ? null : currentSignature");

    expect(signatureIdx).toBeGreaterThan(0);
    expect(compactIdx).toBeGreaterThan(signatureIdx);
    expect(returnIdx).toBeGreaterThan(compactIdx);
  });
});
