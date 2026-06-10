// ABOUTME: Regression test for #2304 — Gemini and Codex cancel must GUARANTEE
// ABOUTME: the agent stops, escalating to killChildTree when cooperative cancel fails.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const codexSource = readFileSync(
  resolve("bin/browser-local/providers.mjs"),
  "utf-8",
);
const geminiSource = readFileSync(
  resolve("bin/browser-local/gemini-runtime.mjs"),
  "utf-8",
);

/** Slice a top-level `async function <name>(` body, bounded by the next
 * `\n  async function ` (sibling closure methods share indent-2). */
function sliceAsyncFn(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return "";
  const after = source.indexOf("\n  async function ", start + 1);
  return after < 0 ? source.slice(start) : source.slice(start, after);
}

describe("#2304 — Codex cancelPrompt escalates to a hard kill when interrupt fails", () => {
  const body = sliceAsyncFn(codexSource, "async function cancelPrompt({ sessionId })");

  it("body extraction succeeds and still attempts the cooperative interrupt", () => {
    expect(body, "Codex cancelPrompt body must be non-empty").not.toBe("");
    expect(body).toContain("turn/interrupt");
  });

  it("escalates to killChildTree on interrupt failure (no longer a silent swallow)", () => {
    expect(
      body,
      "Codex cancelPrompt must hard-kill the child when turn/interrupt is not acknowledged.",
    ).toContain("killChildTree");
    const interruptIdx = body.indexOf("turn/interrupt");
    const killIdx = body.indexOf("killChildTree");
    expect(killIdx, "kill must be an escalation after the interrupt").toBeGreaterThan(
      interruptIdx,
    );
  });

  it("the hard-kill is gated on interrupt failure, not unconditional", () => {
    const hasFlag = /interrupted|interruptOk|stopped/.test(body);
    const hasCatchEscalation = /catch[\s\S]*killChildTree/.test(body);
    expect(
      hasFlag || hasCatchEscalation,
      "killChildTree must be guarded by interrupt-failure (a flag or catch path).",
    ).toBe(true);
  });
});

describe("#2304 — Gemini cancelPrompt escalates to a hard kill when the agent does not stop", () => {
  const body = sliceAsyncFn(geminiSource, "async function cancelPrompt({ sessionId })");

  it("body extraction succeeds and still sends the cooperative cancel", () => {
    expect(body, "Gemini cancelPrompt body must be non-empty").not.toBe("");
    expect(body).toContain("session/cancel");
  });

  it("escalates to killChildTree when the cooperative cancel does not settle the turn", () => {
    // session/cancel is a fire-and-forget notification; if the agent ignores
    // it, only a hard kill stops the child. The kill must be gated on the
    // turn still being active after a grace window (currentPrompt not cleared).
    expect(
      body,
      "Gemini cancelPrompt must hard-kill the child when the cooperative cancel is not honored.",
    ).toContain("killChildTree");
    expect(
      body,
      "the kill must be gated on the turn not settling (currentPrompt liveness).",
    ).toContain("currentPrompt");
  });
});
