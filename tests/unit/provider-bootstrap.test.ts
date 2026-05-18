// ABOUTME: Tests for the deterministic transcript-recap builder used on
// ABOUTME: cross-provider switches into native agents.

import { describe, expect, it } from "vitest";
import {
  buildProviderBootstrapContext,
  providerNeedsBootstrap,
} from "@/lib/provider-bootstrap";

describe("providerNeedsBootstrap", () => {
  it("flags native-agent providers", () => {
    expect(providerNeedsBootstrap("claude-code")).toBe(true);
    expect(providerNeedsBootstrap("codex")).toBe(true);
    expect(providerNeedsBootstrap("gemini")).toBe(true);
  });

  it("skips chat-side providers — they read the canonical transcript directly", () => {
    expect(providerNeedsBootstrap("seren")).toBe(false);
    expect(providerNeedsBootstrap("seren-private")).toBe(false);
    expect(providerNeedsBootstrap("anthropic")).toBe(false);
    expect(providerNeedsBootstrap("openai")).toBe(false);
  });
});

describe("buildProviderBootstrapContext", () => {
  it("produces a deterministic recap that names the user-next-message contract", () => {
    const recap = buildProviderBootstrapContext([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(recap).toContain(
      "Continue from\nthe user's next message",
    );
    expect(recap).toContain("[USER]: hi");
    expect(recap).toContain("[ASSISTANT]: hello");
    expect(recap.startsWith("You are continuing")).toBe(true);
    expect(recap.endsWith("</transcript>")).toBe(true);
  });

  it("is deterministic — same input yields the exact same recap", () => {
    const input = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "second" },
    ];
    expect(buildProviderBootstrapContext(input)).toBe(
      buildProviderBootstrapContext(input),
    );
  });

  it("truncates very long individual messages to the per-message cap", () => {
    const long = "x".repeat(2000);
    const recap = buildProviderBootstrapContext(
      [{ role: "user", content: long }],
      { perMessageChars: 100 },
    );
    expect(recap).toContain("…");
    expect(recap.length).toBeLessThan(1000);
  });

  it("keeps the tail of a long conversation under maxMessages", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }));
    const recap = buildProviderBootstrapContext(messages, { maxMessages: 5 });
    expect(recap).toContain("m49");
    expect(recap).toContain("m45");
    expect(recap).not.toContain("m44");
  });

  it("enforces the overall byte budget end-to-end", () => {
    const messages = Array.from({ length: 30 }, () => ({
      role: "user" as const,
      content: "x".repeat(200),
    }));
    const recap = buildProviderBootstrapContext(messages, {
      perMessageChars: 200,
      maxMessages: 30,
      overallBudgetBytes: 1500,
    });
    // The full recap (header + entries + footer) must not exceed the
    // configured byte budget; the test pins actual enforcement, not just
    // that the loop eventually stops.
    expect(new TextEncoder().encode(recap).length).toBeLessThanOrEqual(1500);
  });

  it("counts UTF-8 bytes for multi-byte content, not UTF-16 code units", () => {
    // Each four-byte UTF-8 emoji is two UTF-16 code units; a string-length
    // check would let roughly 2x as many through and silently bust the
    // budget the caller specified.
    const emoji = "\u{1F600}"; // four UTF-8 bytes
    const messages = Array.from({ length: 50 }, () => ({
      role: "user" as const,
      content: emoji.repeat(20),
    }));
    const recap = buildProviderBootstrapContext(messages, {
      perMessageChars: 200,
      maxMessages: 50,
      overallBudgetBytes: 600,
    });
    expect(new TextEncoder().encode(recap).length).toBeLessThanOrEqual(600);
  });

  it("keeps the most recent entries when the byte budget forces elision", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}-${"x".repeat(80)}`,
    }));
    const recap = buildProviderBootstrapContext(messages, {
      perMessageChars: 200,
      maxMessages: 20,
      overallBudgetBytes: 600,
    });
    // The newest entry must survive even when the budget cannot fit them
    // all; older ones get elided first.
    expect(recap).toContain("msg-19-");
    expect(recap).not.toContain("msg-0-");
  });
});
