// ABOUTME: Unit tests for the Claude Code scaffolding-tag scrubber. #1807.
// ABOUTME: Pure string transformation — no mocks, no fixtures.

import { describe, expect, it } from "vitest";
import { scrubAgentMarkup } from "@/lib/scrub-agent-markup";

describe("scrubAgentMarkup", () => {
  it("strips a single-line <system-reminder> block", () => {
    const input = "Hello.\n<system-reminder>do not use tools</system-reminder>\nWorld.";
    expect(scrubAgentMarkup(input)).toBe("Hello.\n\nWorld.");
  });

  it("strips a multi-line <system-reminder> block as observed in #1807", () => {
    const input = [
      "Resuming.",
      "<system-reminder>",
      "You are in the dynamic mode of the loop skill, where there is no",
      "fixed interval. Use ScheduleWakeup to schedule the next iteration.",
      "</system-reminder>",
      "Done.",
    ].join("\n");
    expect(scrubAgentMarkup(input)).toBe("Resuming.\n\nDone.");
  });

  it("strips <command-message>, <command-name>, and <command-args> blocks", () => {
    const input =
      "Reply.\n<command-message>loop is running…</command-message>\n<command-name>/loop</command-name>\n<command-args>5m</command-args>\nEnd.";
    expect(scrubAgentMarkup(input)).toBe("Reply.\n\nEnd.");
  });

  it("does not collapse mismatched <command-*> open/close pairs", () => {
    const input = "<command-message>x</command-name>";
    expect(scrubAgentMarkup(input)).toBe(input);
  });

  it("preserves <command-stdout> and <local-command-stdout> — those are legitimate captured shell output", () => {
    const input =
      "<local-command-stdout>file: build/main.js</local-command-stdout>\n<command-stdout>npm install ok</command-stdout>";
    expect(scrubAgentMarkup(input)).toBe(input);
  });

  it("returns an empty string when the input is only scaffolding", () => {
    const input =
      "<system-reminder>noop</system-reminder>\n<command-name>/loop</command-name>";
    expect(scrubAgentMarkup(input)).toBe("");
  });

  it("leaves normal markdown / code fences untouched", () => {
    const input = "```ts\nconst x: number = 1;\n```\n\n# Heading\n\n- bullet";
    expect(scrubAgentMarkup(input)).toBe(input);
  });

  it("strips multiple system-reminder blocks in the same message", () => {
    const input =
      "<system-reminder>a</system-reminder>middle<system-reminder>b</system-reminder>";
    expect(scrubAgentMarkup(input)).toBe("middle");
  });

  it("returns the input unchanged when given an empty or whitespace-only string", () => {
    expect(scrubAgentMarkup("")).toBe("");
    expect(scrubAgentMarkup("   \n\n  ")).toBe("");
  });
});
