// ABOUTME: Source-level regression tests for #1686 — standby promotion must
// ABOUTME: own activeSessionId and defer the provider-IPC kill past dispatch.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

const promoteStart = agentStoreSource.indexOf("async promoteStandbyAndDispatch(");
const promoteEnd = agentStoreSource.indexOf(
  "async abortTurn(",
  promoteStart,
);
const promoteBody = agentStoreSource.slice(promoteStart, promoteEnd);

const terminateStart = agentStoreSource.indexOf("async terminateSession(");
const terminateEnd = agentStoreSource.indexOf(
  "setActiveSession(sessionId:",
  terminateStart,
);
const terminateBody = agentStoreSource.slice(terminateStart, terminateEnd);

describe("#1686 — terminateSession accepts an explicit nextActiveSessionId", () => {
  it("declares the opts parameter with nextActiveSessionId and skipProviderKill", () => {
    expect(promoteStart).toBeGreaterThan(0);
    expect(terminateStart).toBeGreaterThan(0);
    // Signature check: opts is optional and exposes both keys. The whitespace
    // tolerance keeps the test stable across Biome formatting changes.
    expect(terminateBody).toMatch(/nextActiveSessionId\?:\s*string\s*\|\s*null/);
    expect(terminateBody).toMatch(/skipProviderKill\?:\s*boolean/);
  });

  it("uses opts.nextActiveSessionId when provided instead of remainingIds[0]", () => {
    // The auto-pickup fallback (remainingIds[0]) must remain reachable so
    // existing callers that pass no opts keep their behaviour, but the
    // explicit branch must come first.
    const explicitIdx = terminateBody.indexOf(
      'if (opts && "nextActiveSessionId" in opts)',
    );
    const fallbackIdx = terminateBody.indexOf("remainingIds[0]");
    expect(explicitIdx, "explicit-next branch must exist").toBeGreaterThan(0);
    expect(fallbackIdx, "fallback must remain").toBeGreaterThan(explicitIdx);
  });

  it("gates the provider-IPC kill on skipProviderKill", () => {
    expect(terminateBody).toContain("if (!opts?.skipProviderKill)");
    expect(terminateBody).toMatch(
      /if \(!opts\?\.skipProviderKill\)\s*\{[\s\S]*?providerService\.terminateSession\(sessionId\)/,
    );
  });
});

describe("#1686 — promoteStandbyAndDispatch fixes the activeSessionId mismatch", () => {
  it("sets activeSessionId to the promoted standby BEFORE terminating the old serving session", () => {
    const setActiveIdx = promoteBody.indexOf(
      'setState("activeSessionId", standbyId!)',
    );
    const terminateCallIdx = promoteBody.indexOf("this.terminateSession(servingSessionId");
    expect(setActiveIdx, "activeSessionId must be set in promote body").toBeGreaterThan(0);
    expect(terminateCallIdx, "terminateSession call must exist").toBeGreaterThan(0);
    expect(
      setActiveIdx,
      "activeSessionId must be set BEFORE terminateSession is called",
    ).toBeLessThan(terminateCallIdx);
  });

  it("passes nextActiveSessionId: standbyId! to terminateSession as defense-in-depth", () => {
    expect(promoteBody).toMatch(
      /this\.terminateSession\(\s*servingSessionId,\s*\{[\s\S]*?nextActiveSessionId:\s*standbyId!/,
    );
  });
});

describe("#1686 — promoteStandbyAndDispatch defers the provider kill past dispatch", () => {
  it("requests skipProviderKill on the pre-dispatch terminateSession call", () => {
    expect(promoteBody).toMatch(
      /this\.terminateSession\(\s*servingSessionId,\s*\{[\s\S]*?skipProviderKill:\s*true/,
    );
  });

  it("invokes providerService.terminateSession AFTER sendPrompt, inside a finally block", () => {
    const sendPromptIdx = promoteBody.indexOf(
      "this.sendPrompt(prompt, context, options, standbyId!)",
    );
    const finallyIdx = promoteBody.indexOf("finally", sendPromptIdx);
    const providerKillIdx = promoteBody.indexOf(
      "providerService.terminateSession(servingSessionId)",
      finallyIdx,
    );
    expect(sendPromptIdx, "sendPrompt call must exist").toBeGreaterThan(0);
    expect(finallyIdx, "finally block must follow sendPrompt").toBeGreaterThan(
      sendPromptIdx,
    );
    expect(
      providerKillIdx,
      "deferred providerService.terminateSession must live inside the finally",
    ).toBeGreaterThan(finallyIdx);
  });
});
