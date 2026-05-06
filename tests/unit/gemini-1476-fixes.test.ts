// ABOUTME: Critical regression guards for the #1476 Gemini Agent end-to-end fixes.
// ABOUTME: Six tests, each guarding a specific footgun a future refactor could
// ABOUTME: reintroduce silently. Source-text and type-system tests have been
// ABOUTME: deliberately excluded — tsc and the existing 27 tests in
// ABOUTME: tests/unit/gemini-agent.test.ts already cover those.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const geminiRuntimeMjs = readFileSync(
  resolve("bin/browser-local/gemini-runtime.mjs"),
  "utf-8",
);
const agentStoreTs = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const skillsServiceTs = readFileSync(
  resolve("src/services/skills.ts"),
  "utf-8",
);
const qrcodeShimTs = readFileSync(
  resolve("src/lib/qrcode-shim.ts"),
  "utf-8",
);
const viteConfigTs = readFileSync(resolve("vite.config.ts"), "utf-8");

describe("Gemini Agent #1476 — load-bearing regression guards", () => {
  // ─── Slice A: white screen ────────────────────────────────────────────
  it("qrcode-shim uses namespace import, not default import", () => {
    // Default import from a CJS-only module white-screens Vite 8 dev mode.
    // The bug already happened once and was missed for 4 sessions because
    // production vite build masks it. Easy to reintroduce in any "cleanup" PR.
    expect(qrcodeShimTs).toMatch(
      /import\s+\*\s+as\s+qrcode\s+from\s+"qrcode\/lib\/browser\.js"/,
    );
    expect(qrcodeShimTs).not.toMatch(/^import\s+qrcode\s+from/m);
  });

  it("vite alias is exact-match regex so the qrcode subpath escapes the shim", () => {
    // String-prefix `qrcode:` would match `qrcode/lib/browser.js` and
    // recurse back into the shim, breaking dev mode.
    expect(viteConfigTs).toMatch(/find:\s*\/\^qrcode\$\//);
  });

  // ─── Slice B: never accept Homebrew gemini-cli ───────────────────────
  it("gemini-runtime resolveGeminiBinary does NOT include Homebrew paths", () => {
    // The whole reason this PR exists. /usr/local/bin/gemini and
    // /opt/homebrew/bin/gemini are deliberately excluded — Homebrew's
    // gemini-cli ships without compiled keytar and cannot read its
    // own keychain when launched from a GUI app.
    const idx = geminiRuntimeMjs.indexOf("function resolveGeminiBinary");
    expect(idx).toBeGreaterThan(-1);
    const fnSlice = geminiRuntimeMjs.slice(idx, idx + 2000);
    expect(fnSlice).not.toContain('"/usr/local/bin/gemini"');
    expect(fnSlice).not.toContain('"/opt/homebrew/bin/gemini"');
  });

  // ─── Slice C: login-required handler position ───────────────────────
  it("agent.store handles loginRequired BEFORE the session-routing logic", () => {
    // The auth event arrives BEFORE the session is registered in
    // state.sessions (the spawn promise is still pending). If the
    // loginRequired handler is moved below the `state.sessions[id]` check,
    // the event gets buffered into pendingSessionEvents and the user
    // never sees the login flow trigger.
    const handlerIdx = agentStoreTs.indexOf('event.type === "loginRequired"');
    const sessionRoutingIdx = agentStoreTs.indexOf(
      "state.sessions[eventSessionId]",
    );
    expect(handlerIdx).toBeGreaterThan(-1);
    expect(sessionRoutingIdx).toBeGreaterThan(-1);
    expect(handlerIdx).toBeLessThan(sessionRoutingIdx);
  });

  // ─── Slice D: legacy skill fetch paths stay removed ──────────────────
  it("src/services/skills.ts contains zero GitHub or R2 skill fetch paths", () => {
    // Desktop skill discovery and bundle install should go through the generated
    // Seren Skills API client. Reintroducing raw GitHub or R2 paths would split
    // the source of truth for payload files and revision metadata.
    expect(skillsServiceTs).not.toContain("api.github.com");
    expect(skillsServiceTs).not.toContain("raw.githubusercontent.com");
    expect(skillsServiceTs).not.toContain("r2.dev/skills");
  });

  it("skills service uses the generated Seren Skills API client", () => {
    expect(skillsServiceTs).toContain('from "@/api/seren-skills"');
    expect(skillsServiceTs).toContain("downloadSkill");
    expect(skillsServiceTs).toContain("listSkills");
  });
});
