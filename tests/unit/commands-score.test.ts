// ABOUTME: Pins the boundary-aware scoring used by slash-command/skill autocomplete.
// ABOUTME: Lower scores win; null means no match.

import { describe, expect, it } from "vitest";
import { bestScore, scoreCandidate } from "@/lib/commands/score";

describe("scoreCandidate", () => {
  it("returns 0 for an exact case-insensitive match", () => {
    expect(scoreCandidate("prophet-arb-bot", "prophet-arb-bot")).toBe(0);
    expect(scoreCandidate("PROPHET-ARB-BOT", "prophet-arb-bot")).toBe(0);
  });

  it("returns 1 for a prefix match", () => {
    expect(scoreCandidate("prophet-arb-bot", "prophet")).toBe(1);
    expect(scoreCandidate("prophet-arb-bot", "p")).toBe(1);
  });

  it("scores boundary matches better than mid-segment substring matches", () => {
    const boundary = scoreCandidate("prophet-arb-bot", "arb");
    const substring = scoreCandidate("prophetarbbot", "arb");
    expect(boundary).not.toBeNull();
    expect(substring).not.toBeNull();
    expect(boundary!).toBeLessThan(substring!);
  });

  it("matches `bot` at the trailing boundary", () => {
    expect(scoreCandidate("prophet-arb-bot", "bot")).toBeLessThan(100);
  });

  it("matches initials of boundary-delimited segments", () => {
    const initials = scoreCandidate("prophet-arb-bot", "pab");
    expect(initials).not.toBeNull();
    expect(initials!).toBeGreaterThanOrEqual(200);
  });

  it("ranks the more specific candidate higher when both match the query", () => {
    // `arb` is a prefix of `arb-only` and a boundary match in
    // `prophet-arb-bot`. Prefix should outrank boundary.
    const prefix = scoreCandidate("arb-only", "arb");
    const boundary = scoreCandidate("prophet-arb-bot", "arb");
    expect(prefix).not.toBeNull();
    expect(boundary).not.toBeNull();
    expect(prefix!).toBeLessThan(boundary!);
  });

  it("returns null when there is no match at all", () => {
    expect(scoreCandidate("prophet-arb-bot", "xyz")).toBeNull();
    expect(scoreCandidate("clear", "qq")).toBeNull();
  });

  it("returns 0 for an empty query (every candidate matches)", () => {
    expect(scoreCandidate("anything", "")).toBe(0);
  });

  it("handles underscore and slash boundaries", () => {
    expect(scoreCandidate("seren_agent_bot", "agent")).toBeLessThan(100);
    expect(scoreCandidate("scope/sub-skill", "sub")).toBeLessThan(100);
  });
});

describe("bestScore", () => {
  it("returns the smaller numeric score", () => {
    expect(bestScore(1, 5)).toBe(1);
    expect(bestScore(5, 1)).toBe(1);
  });

  it("falls back to whichever side is non-null", () => {
    expect(bestScore(null, 3)).toBe(3);
    expect(bestScore(3, null)).toBe(3);
  });

  it("returns null when both sides are null", () => {
    expect(bestScore(null, null)).toBeNull();
  });
});
