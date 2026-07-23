// ABOUTME: Critical regression test for #1736 — support-pipeline submission
// ABOUTME: failures must surface as console.warn with the report signature so
// ABOUTME: silent drops can be diagnosed instead of vanishing into console.debug.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const hookSource = readFileSync(
  resolve("src/lib/support/hook.ts"),
  "utf-8",
);
const nativeSupportSource = readFileSync(
  resolve("src-tauri/src/support.rs"),
  "utf-8",
);

describe("#1736 support-pipeline submission failures are loud, not silent", () => {
  it("submitPayload surfaces non-2xx fetch responses as a failure (response.ok / status check)", () => {
    // The original `await fetch(...)` swallowed non-2xx responses because
    // fetch only throws on network errors, not on HTTP errors. Without an
    // explicit response.ok check, a Gateway 5xx looks like success and
    // captureSupportError's `.catch(...)` never fires.
    const fnIdx = hookSource.indexOf("async function submitPayload(");
    expect(fnIdx).toBeGreaterThan(0);
    const fn = hookSource.slice(fnIdx, fnIdx + 2000);
    expect(fn).toMatch(/response\.ok|response\.status|\.status\s*[<>=!]/);
  });

  it("the missing-session-token skip is logged with a structured reason", () => {
    // The browser path must identify a missing session credential rather
    // than silently dropping the report. Pin the literal reason so a
    // rename in the warn message does not silently regress the audit
    // trail.
    expect(hookSource).toMatch(/no-session-token/);
  });

  it("native support submission uses the refreshable session credential", () => {
    expect(nativeSupportSource).toMatch(/auth::authenticated_request/);
    expect(nativeSupportSource).not.toMatch(/SEREN_API_KEY_KEY|read_api_key/);
  });

  it("submission failure logging uses console.warn (not console.debug) and includes the report signature", () => {
    // console.debug is below the support log slice's level threshold and
    // also below most operator log filters. The warn carries the failure
    // reason and the report signature (or a short prefix) so a user can
    // correlate "I saw an error" with "this is why no ticket exists."
    // console.warn is captured to the support log slice via the install
    // hook's wrapper without recursing into captureSupportError, so the
    // re-entrancy guard at hook.ts:52 stays intact.
    expect(hookSource).toMatch(/console\.warn\([^)]*support-report/);
    // Pin the signature reference in the warn payload so the correlation
    // hook is auditable.
    const warnIdx = hookSource.search(/console\.warn\([^)]*support-report/);
    expect(warnIdx).toBeGreaterThan(0);
    const region = hookSource.slice(warnIdx, warnIdx + 300);
    expect(region).toMatch(/signature/);
  });
});
