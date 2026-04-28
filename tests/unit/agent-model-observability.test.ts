// ABOUTME: Source-level regression tests for #1718 — instrument all three
// ABOUTME: agent runtimes (Claude / Codex / Gemini) so picker/runtime model
// ABOUTME: divergence is always visible in the app log.

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
const geminiRuntime = readFileSync(
  resolve("bin/browser-local/gemini-runtime.mjs"),
  "utf-8",
);

describe("#1718 Claude runtime — chooseUpdatedModelId + set_model are logged", () => {
  it("logs every chooseUpdatedModelId resolution in the message handler", () => {
    // The message handler calls chooseUpdatedModelId (#1635). Without a log
    // here, the only signal that the CLI's `message.model` disagrees with
    // the picker is the visible UI flip — there is no record we can audit
    // after the fact. The log line must include `previous`, `incoming`, and
    // `resolved` so the diagnosis is unambiguous.
    const callIdx = claudeRuntime.indexOf("chooseUpdatedModelId(");
    expect(callIdx).toBeGreaterThan(0);
    const region = claudeRuntime.slice(callIdx, callIdx + 1200);
    expect(region).toMatch(/console\.(log|info|warn)\(/);
    expect(region).toMatch(/chooseUpdatedModelId/);
    expect(region).toMatch(/previous/);
    expect(region).toMatch(/incoming/);
    expect(region).toMatch(/resolved/);
  });

  it("logs every set_model control response so silent CLI fallbacks are visible", () => {
    // Find the setModel function and verify a log is emitted around the
    // sendControlRequest response. The existing #1679 "not in catalog"
    // warn only fires on the catalog-miss path; we need a log on the
    // success path too so we can see what the CLI actually accepted.
    const fnIdx = claudeRuntime.indexOf("async function setModel(");
    expect(fnIdx).toBeGreaterThan(0);
    const region = claudeRuntime.slice(fnIdx, fnIdx + 2000);
    expect(region).toMatch(/sendControlRequest\([\s\S]*?set_model/);
    // At least one console call after the control request that surfaces
    // either the requested model id or the response payload.
    const after = region.slice(region.indexOf("sendControlRequest"));
    expect(after).toMatch(/console\.(log|info|warn)\([\s\S]*?(set_model|requested)/);
  });
});

describe("#1718 Codex runtime — thread/start model adoption is logged", () => {
  it("logs when threadResult.model differs from the requested selection", () => {
    // Codex picks `threadResult.model ?? selected ?? records[0]` after
    // thread/start. If thread/start hands back a different id than what the
    // user picked, that's the only place a fallback can surface — log it.
    const idx = providersRuntime.indexOf(
      "session.currentModelId =\n        threadResult?.model",
    );
    // Tolerate either the multi-line or single-line styling, fall back to
    // a substring that pins both fields together.
    const anchor =
      idx > 0
        ? idx
        : providersRuntime.indexOf("threadResult?.model ??");
    expect(anchor).toBeGreaterThan(0);
    const region = providersRuntime.slice(anchor - 400, anchor + 1200);
    expect(region).toMatch(/console\.(log|info|warn)\(/);
    expect(region).toMatch(/threadResult/);
    expect(region).toMatch(/(requested|served|selected)/);
  });
});

describe("#1718 Gemini runtime — mid-session setModel surfaces as a warn", () => {
  it("setModel emits a console.warn explaining it is a no-op until the next spawn", () => {
    // Mid-session setModel does not plumb to gemini-cli (Phase 1 limitation
    // documented in the runtime). Without a log the user can change the
    // picker and never know the running process is unchanged.
    const fnIdx = geminiRuntime.indexOf("async function setModel(");
    expect(fnIdx).toBeGreaterThan(0);
    const region = geminiRuntime.slice(fnIdx, fnIdx + 1200);
    expect(region).toContain("console.warn(");
    // Pin the message text so the warn cannot be silently rewritten into
    // something less honest.
    expect(region).toMatch(/(no-op|spawn[ -]time)/);
  });
});
