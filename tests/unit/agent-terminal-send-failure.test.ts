// ABOUTME: Regression coverage for #2537 — provider send failures must not
// ABOUTME: leave agent turns stuck in-flight or duplicate adjacent error rows.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

const agentStoreSource = readSource("src/stores/agent.store.ts");

const failTurnStart = agentStoreSource.indexOf("failTurnForSession(");
const failTurnBody = agentStoreSource.slice(failTurnStart, failTurnStart + 2200);

const sendPromptCatchStart = agentStoreSource.indexOf(
  "console.error(`[AgentStore] sendPrompt error",
);
const sendPromptCatchBody = agentStoreSource.slice(
  sendPromptCatchStart,
  sendPromptCatchStart + 1800,
);

const genericProviderErrorStart = agentStoreSource.indexOf(
  "this.addErrorMessage(sessionId, event.data.error);\n            this.failTurnForSession(sessionId, errStr);",
);
const genericProviderErrorBody = agentStoreSource.slice(
  genericProviderErrorStart - 500,
  genericProviderErrorStart + 500,
);

const promptTooLongFallbackStart = agentStoreSource.indexOf(
  "Compaction failed catastrophically",
);
const promptTooLongFallbackBody = agentStoreSource.slice(
  promptTooLongFallbackStart,
  promptTooLongFallbackStart + 2200,
);

const addErrorStart = agentStoreSource.indexOf("addErrorMessage(sessionId: string");
const addErrorBody = agentStoreSource.slice(addErrorStart, addErrorStart + 1500);

describe("#2537 — terminal provider send failures restore UI turn state", () => {
  it("has a helper that maps session failures back to the conversation turn", () => {
    expect(failTurnStart).toBeGreaterThan(0);
    expect(failTurnBody).toContain("const threadId = session?.conversationId");
    expect(failTurnBody).toContain("this.isTurnInFlight(threadId)");
    expect(failTurnBody).toContain('session.info.status === "prompting"');
    expect(failTurnBody).toContain("this.setTurnError(threadId, kind, message)");
    expect(failTurnBody).toContain('"ready" as SessionStatus');
  });

  it("direct sendPrompt failures add one error row and clear the in-flight turn", () => {
    expect(sendPromptCatchStart).toBeGreaterThan(0);
    expect(sendPromptCatchBody).toContain("this.addErrorMessage(sessionId, message)");
    expect(sendPromptCatchBody).toContain("this.failTurnForSession(sessionId, message)");
  });

  it("prompt-too-long rejections without an event-side compact promise terminalize the turn", () => {
    expect(sendPromptCatchBody).toContain("if (compactPromise)");
    expect(sendPromptCatchBody).toContain("} else {\n          this.addErrorMessage(sessionId, message);\n          this.failTurnForSession(sessionId, message);");
  });

  it("generic provider error events terminalize active turns instead of relying on sendPrompt catch", () => {
    expect(genericProviderErrorStart).toBeGreaterThan(0);
    expect(genericProviderErrorBody).toContain("this.addErrorMessage(sessionId, event.data.error)");
    expect(genericProviderErrorBody).toContain("this.failTurnForSession(sessionId, errStr)");
  });

  it("terminal prompt-too-long compaction outcomes clear the thinking indicator", () => {
    expect(promptTooLongFallbackStart).toBeGreaterThan(0);
    expect(promptTooLongFallbackBody).toContain(
      "this.failTurnForSession(sessionId, String(event.data.error))",
    );
    expect(promptTooLongFallbackBody).toContain("const terminalMessage");
    expect(promptTooLongFallbackBody).toContain(
      "this.failTurnForSession(sessionId, terminalMessage)",
    );
  });

  it("adjacent duplicate error messages are suppressed while keeping the banner current", () => {
    expect(addErrorStart).toBeGreaterThan(0);
    expect(addErrorBody).toContain("const lastMessage = session?.messages.at(-1)");
    expect(addErrorBody).toMatch(
      /lastMessage\?\.type\s*!==\s*"error"\s*\|\|\s*lastMessage\.content\s*!==\s*prefixedError/,
    );
    expect(addErrorBody).toContain('setState("sessions", sessionId, "error", prefixedError)');
  });
});
