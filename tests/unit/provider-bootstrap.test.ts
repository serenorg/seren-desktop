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

  it("stops at the overall byte budget even when room remains in maxMessages", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: "x".repeat(200),
    }));
    const recap = buildProviderBootstrapContext(messages, {
      perMessageChars: 200,
      maxMessages: 30,
      overallBudget: 500,
    });
    // Budget is small enough that very few of the 30 entries can fit.
    const lines = recap
      .split("\n")
      .filter((l) => l.startsWith("[USER]:"));
    expect(lines.length).toBeLessThan(5);
  });
});
