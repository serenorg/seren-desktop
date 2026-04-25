// ABOUTME: Regression tests for #1652 — context-overflow on expired session must surface Sign In.
// ABOUTME: Covers isContextOverflowError, banner wiring, and provider-scoped pre-send gate removal.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isContextOverflowError } from "@/lib/auth-errors";

const chatContentSource = readFileSync(
  resolve("src/components/chat/ChatContent.tsx"),
  "utf-8",
);

describe("#1652 — isContextOverflowError", () => {
  it("matches the strings Anthropic returns on context overflow", () => {
    expect(isContextOverflowError("Prompt is too long")).toBe(true);
    expect(isContextOverflowError("prompt is too long: 897960 tokens > 200000")).toBe(true);
    expect(isContextOverflowError("context length exceeded")).toBe(true);
    expect(isContextOverflowError("context window exceeded")).toBe(true);
  });

  it("does not false-positive on normal text", () => {
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError("")).toBe(false);
    expect(isContextOverflowError("The prompt is short and well-formed")).toBe(false);
    expect(isContextOverflowError("Here is some context about the project")).toBe(false);
  });
});

describe("#1652 — per-message banner shows Sign In on context-overflow when unauthenticated", () => {
  it("imports isContextOverflowError from auth-errors", () => {
    expect(chatContentSource).toContain(
      "isContextOverflowError",
    );
    expect(chatContentSource).toMatch(
      /from ["']@\/lib\/auth-errors["']/,
    );
  });

  it("banner treats context-overflow as session-expired iff !authStore.isAuthenticated", () => {
    // The Show-when predicate must combine isAuthError with a context-overflow
    // branch gated on !authStore.isAuthenticated. We assert on the anchor
    // string so the banner fallback (the Sign In button) fires for the
    // "Prompt is too long" case when the user is signed out.
    const bannerAnchor = "Session expired. Please sign in to continue.";
    const bannerIdx = chatContentSource.indexOf(bannerAnchor);
    expect(bannerIdx, "session-expired banner anchor must exist").toBeGreaterThan(0);

    // Walk backwards from the banner anchor to the governing `Show when={...}`
    // — the predicate for that Show must reference both isAuthError and the
    // context-overflow + unauthenticated condition.
    const showOpen = chatContentSource.lastIndexOf("<Show", bannerIdx);
    expect(showOpen, "governing Show must exist before banner").toBeGreaterThan(0);
    const predicate = chatContentSource.slice(showOpen, bannerIdx);

    expect(predicate).toContain("isAuthError(message.error)");
    expect(predicate).toContain("isContextOverflowError(message.error)");
    expect(predicate).toContain("!authStore.isAuthenticated");
  });
});

describe("#1652 — pre-send sign-in gate is not provider-scoped", () => {
  it("does not scope the sign-in gate to seren / seren-private providers", () => {
    // Before the fix there were two guards of the form
    //   (activeProvider === "seren" || activeProvider === "seren-private") && !isAuthenticated
    // that bypassed the Sign In prompt on Claude Code and other providers.
    // Locate every call site of setShowSignInPrompt(true) inside a pre-send
    // gate and assert the provider scoping is gone.
    const gateCall = 'setShowSignInPrompt(true)';
    let idx = 0;
    let gateCount = 0;
    while ((idx = chatContentSource.indexOf(gateCall, idx)) !== -1) {
      // Look at the 400 chars preceding each gate call — the governing `if`
      // condition lives there for the pre-send guards. Skip the <button
      // onClick> site (short window, no `if (`).
      const window = chatContentSource.slice(Math.max(0, idx - 400), idx);
      if (window.includes("if (") && window.includes("!authStore.isAuthenticated")) {
        expect(
          window,
          "pre-send gate must not check activeProvider === 'seren'",
        ).not.toMatch(/activeProvider === ["']seren["']/);
        expect(
          window,
          "pre-send gate must not check activeProvider === 'seren-private'",
        ).not.toMatch(/activeProvider === ["']seren-private["']/);
        gateCount++;
      }
      idx += gateCall.length;
    }

    // Both pre-send gates (sendMessage + sendMessageImmediate) must exist.
    expect(gateCount, "both pre-send gates must still guard on auth").toBe(2);
  });
});
