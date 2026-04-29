// ABOUTME: Critical regression tests for #1735 — resolveClaudeBinary must
// ABOUTME: validate executability (not just existence), and codex spawn must
// ABOUTME: attach an 'error' listener so a missing binary doesn't crash the
// ABOUTME: provider-runtime via an unhandled ChildProcess error event.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const claudeRuntime = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);
const providersRuntime = readFileSync(
  resolve("bin/browser-local/providers.mjs"),
  "utf-8",
);

describe("#1735 A1 — resolveClaudeBinary validates executability before returning a candidate", () => {
  it("the candidate validator uses X_OK access in a try/catch and resolveClaudeBinary calls it", () => {
    // existsSync alone is not enough: a broken symlink, a stale install
    // entry, or a non-executable file passes existsSync but fails spawn
    // with ENOENT/EACCES. The user's session at 2026-04-29 07:08:46
    // returned ~/.local/bin/claude, which then failed at spawn time on
    // every recovery attempt. Real fix: the candidate loop must validate
    // executability before returning, and fall through on rejection.
    //
    // The validator may live as a helper next to resolveClaudeBinary;
    // assert against the file as a whole (a) X_OK is checked inside a
    // try/catch (the natural way to fall through on EACCES/ENOENT thrown
    // by accessSync), and (b) resolveClaudeBinary uses the validator
    // before returning a candidate.
    expect(claudeRuntime).toMatch(
      /try\s*\{[\s\S]*?(constants\.X_OK|fsConstants\.X_OK|X_OK)[\s\S]*?\}\s*catch/,
    );
    const fnIdx = claudeRuntime.indexOf("function resolveClaudeBinary(");
    expect(fnIdx).toBeGreaterThan(0);
    const fn = claudeRuntime.slice(fnIdx, fnIdx + 4000);
    // The candidate loop must reference an executability gate, not just
    // existsSync. Either inline (X_OK reference) or via a named helper
    // whose name signals the check.
    expect(fn).toMatch(/X_OK|isExecutableCandidate/);
  });
});

describe("#1735 A2 — codex spawn attaches an 'error' listener so missing binary doesn't crash the runtime", () => {
  it("attachProcessListeners registers a process 'error' listener", () => {
    // When `/usr/local/bin/codex` is missing, Node emits an 'error' event
    // on the ChildProcess. With no listener, Node's default re-throws as
    // an uncaughtException, killing the entire provider-runtime helper —
    // which then takes down every agent runtime (claude, gemini, codex).
    // The fix attaches a listener that translates the spawn error into a
    // structured per-session error event the UI can show.
    const fnIdx = providersRuntime.indexOf("function attachProcessListeners(");
    expect(fnIdx).toBeGreaterThan(0);
    const fn = providersRuntime.slice(fnIdx, fnIdx + 2000);
    expect(fn).toMatch(/session\.process\.on\(\s*"error"/);
    // The listener must emit a provider://error so the UI surfaces a
    // recoverable per-session failure rather than the runtime dying
    // silently from the user's POV.
    expect(fn).toMatch(/emit\([\s\S]*?provider:\/\/error/);
  });
});
