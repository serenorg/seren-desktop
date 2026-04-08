// ABOUTME: Critical regression guard for #1486 — gemini-runtime session/prompt
// ABOUTME: timeout must not crash the provider-runtime via orphaned promise.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const geminiRuntimeMjs = readFileSync(
  resolve("bin/browser-local/gemini-runtime.mjs"),
  "utf-8",
);

describe("Gemini #1486 — pendingPrompt orphaned rejection crash", () => {
  it("pendingPrompt must attach a catch handler so rejections don't crash Node", () => {
    // The bug: sendPrompt creates `pendingPrompt` whose reject fn is stashed
    // on session.currentPrompt. Four sites call rejectCurrentPrompt (sendPrompt
    // catch block, process exit handler, cancelPrompt, terminateSession) — any
    // of them can reject pendingPrompt before the success-path
    // `await pendingPrompt` ever runs. Without a handler on pendingPrompt, the
    // rejection is orphaned → Node 22 unhandledRejection → the entire
    // provider-runtime process crashes, killing every session (including
    // Claude Code) that shares the runtime.
    //
    // Guard: the `.catch(` handler must appear on pendingPrompt, within a
    // small window after its declaration, BEFORE the `try {` block. If a
    // future refactor deletes this line, the crash cascade returns.
    const declIdx = geminiRuntimeMjs.indexOf("const pendingPrompt = new Promise");
    expect(declIdx).toBeGreaterThan(-1);

    // Look at the region between the declaration and the first `try {` after it.
    const tryIdx = geminiRuntimeMjs.indexOf("try {", declIdx);
    expect(tryIdx).toBeGreaterThan(declIdx);
    const region = geminiRuntimeMjs.slice(declIdx, tryIdx);

    // Some form of pendingPrompt.catch(...) must be present in that region.
    // Accept variations like `pendingPrompt.catch(() => {})` or
    // `pendingPrompt.catch(noop)` — the specific form doesn't matter, only
    // that pendingPrompt has a rejection handler attached before the try
    // block runs any code that could reject it.
    expect(region).toMatch(/pendingPrompt\.catch\s*\(/);
  });
});
