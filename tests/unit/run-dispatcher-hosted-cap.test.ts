// ABOUTME: Critical regression coverage for the hosted-model task time bound.
// ABOUTME: Protects the turn cap applied to every hosted dispatch call site.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

describe("#3616 hosted-model mission tasks are time-bounded", () => {
  it("wraps every hosted call site in the shared deadline", () => {
    const source = readSource("src/services/run-dispatcher.ts");

    // All four hosted dispatch paths (seren, seren-private, unknown-label
    // fallback, native-session fallback) must run under the turn cap so a
    // stalled stream fails the attempt and frees its slot.
    const wrapped = source.match(/withHostedTaskDeadline\(\s*runSeren/g) ?? [];
    expect(wrapped.length).toBe(4);

    // No hosted call site may bypass the deadline.
    expect(source).not.toMatch(/await runSerenChatTask\(/);
    expect(source).not.toMatch(/await runSerenPrivateTask\(/);
  });
});
