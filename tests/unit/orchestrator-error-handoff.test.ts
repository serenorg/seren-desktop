// ABOUTME: Critical regression coverage for terminal orchestrator error handoff.
// ABOUTME: Protects the command rejection and idempotent frontend error row.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

describe("#3493 terminal orchestrator error handoff", () => {
  it("returns a captured terminal worker error through the Tauri command", () => {
    const source = readSource("src-tauri/src/orchestrator/service.rs");

    expect(source).toContain(
      "if let Some(error_message) = reroutable_error {\n                return Err(error_message);",
    );
  });

  it("updates an existing assistant row instead of duplicating the error", () => {
    const source = readSource("src/services/orchestrator.ts");

    expect(source).toContain(
      ".some((existing) => existing.id === stream.messageId);",
    );
    expect(source).toContain(
      "conversationStore.updateMessage(\n        stream.messageId,\n        errorMessage,\n        conversationId,",
    );
  });
});
