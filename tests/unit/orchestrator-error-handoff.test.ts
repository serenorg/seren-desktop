// ABOUTME: Critical regression coverage for terminal orchestrator error handoff.
// ABOUTME: Protects the command rejection and idempotent frontend error row.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

describe("#3493 terminal orchestrator error handoff", () => {
  it("returns a captured terminal worker error through the Tauri command", () => {
    const source = readSource("src-tauri/src/orchestrator/service.rs");

    expect(source).toContain(
      "emit_terminal_failure(app, conversation_id, &failure.message, failed_attempt_cost);",
    );
    expect(source).toContain("return Err(failure.message);");
  });

  it("updates an existing assistant row instead of duplicating the error", () => {
    const source = readSource("src/services/orchestrator.ts");

    expect(source).toContain(
      ".find((message) => message.id === stream.messageId);",
    );
    expect(source).toContain(
      "conversationStore.updateMessage(\n        stream.messageId,\n        errorMessage,\n        conversationId,",
    );
    expect(source).toContain("cost: cost ?? existing?.cost,");
  });
});
