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

  // #1827: post-compaction stock acknowledgement leak. The seed prompt
  // ("Confirm you have this context… wait for the user's next message")
  // combined with the runtime's <system-reminder> injections triggers a
  // stock training-data response. If a race / refactor lets this turn
  // escape the role==="standby" event filter, scrubAgentMarkup must drop
  // it so it never persists into the transcript or Seren memory.
  describe("#1827 — drops the post-compaction seed-ack stock pattern", () => {
    it("drops the literal observed wording", () => {
      const input =
        "I'll acknowledge the system reminders. No user request to act on yet—standing by";
      expect(scrubAgentMarkup(input)).toBe("");
    });

    it("drops the variant with an ASCII hyphen instead of em-dash", () => {
      const input =
        "I'll acknowledge the system reminders. No user request to act on yet - standing by.";
      expect(scrubAgentMarkup(input)).toBe("");
    });

    it("drops the variant with leading whitespace and a trailing period", () => {
      const input =
        "  I'll acknowledge the system reminders. No user request to act on yet, standing by.  ";
      expect(scrubAgentMarkup(input)).toBe("");
    });

    it("drops the 'I will acknowledge' (no contraction) variant", () => {
      const input =
        "I will acknowledge the system reminders. No user request to act on yet—standing by";
      expect(scrubAgentMarkup(input)).toBe("");
    });

    it("preserves a real assistant turn that merely contains 'standing by' as a phrase", () => {
      // Don't false-positive on legitimate prose. The stock pattern requires
      // the "I('ll| will) acknowledge the system reminders" preamble to
      // anchor the match.
      const input =
        "The validator service is healthy and standing by for traffic.";
      expect(scrubAgentMarkup(input)).toBe(input);
    });
  });
});
