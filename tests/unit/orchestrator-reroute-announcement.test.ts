// ABOUTME: Critical regression coverage for single reroute announcements.
// ABOUTME: Protects the once-per-task transition emission in the retry loop.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

describe("#3603 one announcement per model switch", () => {
  it("emits the initial routing transition only on the first attempt", () => {
    const source = readSource("src-tauri/src/orchestrator/service.rs");

    // The retry loop must gate the transition so retry/reroute iterations
    // cannot re-announce the routing reason a Reroute event already covers.
    expect(source).toContain("let mut initial_transition_emitted = false;");
    expect(source).toContain("if !initial_transition_emitted {");
    expect(source).toContain("initial_transition_emitted = true;");
  });

  it("keeps reroute announcements and terminal failure rows intact", () => {
    const source = readSource("src-tauri/src/orchestrator/service.rs");

    // Every model switch still announces itself through WorkerEvent::Reroute,
    // and terminal give-up paths still emit a failure row.
    expect(source).toContain("worker_event: WorkerEvent::Reroute {");
    expect(source).toContain(
      "emit_terminal_failure(app, conversation_id, &error_msg, failed_attempt_cost);",
    );
  });
});
