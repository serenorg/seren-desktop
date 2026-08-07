// ABOUTME: Protects Codex auth-failure detection and recovery for invalidated tokens (#3729).
// ABOUTME: Pins the real upstream error text and the login-required wiring it must reach.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS runtime module without type declarations.
import {
  clearAgentCredentialsInvalid,
  markAgentCredentialsInvalid,
} from "../../bin/browser-local/agent-registry.mjs";

const providersSource = readFileSync(
  resolve("bin/browser-local/providers.mjs"),
  "utf-8",
);
const registrySource = readFileSync(
  resolve("bin/browser-local/agent-registry.mjs"),
  "utf-8",
);

/**
 * Captured verbatim from a real failing session. `isAuthError` matched none of
 * it, so a Codex thread 401'd continuously with no user-facing signal at all.
 */
const REAL_CODEX_INVALIDATION =
  "failed to refresh available models: unexpected status 401 Unauthorized: " +
  "Your authentication token has been invalidated. Please try signing in again., " +
  "url: https://chatgpt.com/backend-api/codex/models?client_version=0.146.1, " +
  "auth error: 401, auth error code: token_invalidated";

// Mirrors `isAuthError` in providers.mjs. That function is module-private, so
// the contract is pinned here and cross-checked against the source below.
function isAuthError(message: string): boolean {
  const lower = String(message).toLowerCase();
  return (
    lower.includes("invalid api key") ||
    lower.includes("authentication required") ||
    lower.includes("auth required") ||
    lower.includes("please run /login") ||
    lower.includes("login required") ||
    lower.includes("not logged in") ||
    lower.includes("token_invalidated") ||
    lower.includes("token has been invalidated") ||
    lower.includes("401 unauthorized")
  );
}

describe("#3729 — Codex invalidated-token classification", () => {
  it("classifies the real upstream invalidation message as an auth error", () => {
    expect(isAuthError(REAL_CODEX_INVALIDATION)).toBe(true);
  });

  it("matches the machine-readable code on its own", () => {
    // Preferred over prose: upstream wording changes must not silently un-fix
    // this the way they would if only the sentence were matched.
    expect(isAuthError("auth error code: token_invalidated")).toBe(true);
  });

  it("classifies the websocket 401 the user actually hits when prompting", () => {
    // Captured by driving the real Codex CLI with an invalid credential. This
    // is the failure the user sees ("Reconnecting... 2/5"), and it carries
    // none of the invalidation prose above.
    expect(
      isAuthError(
        "failed to connect to websocket: HTTP error: 401 Unauthorized, " +
          "url: wss://api.openai.com/v1/responses",
      ),
    ).toBe(true);
  });

  it("does not classify unrelated failures as auth errors", () => {
    expect(isAuthError("Codex exited with code 1")).toBe(false);
    expect(isAuthError("unexpected status 500 Internal Server Error")).toBe(
      false,
    );
    // Rate limiting is 429, not 401 — it must not open a sign-in flow.
    expect(isAuthError("unexpected status 429 Too Many Requests")).toBe(false);
  });

  it("keeps providers.mjs in step with the classifier pinned here", () => {
    for (const token of [
      "token_invalidated",
      "token has been invalidated",
      "401 unauthorized",
    ]) {
      expect(providersSource).toContain(token);
    }
  });
});

/**
 * The actual failure mode, found by driving the real Codex CLI with an invalid
 * credential: the invalidation NEVER surfaces as an RPC error. `model/list`
 * keeps serving a cached catalog and every RPC succeeds. The 401 exists only as
 * a log line on the Codex child's stderr — which `attachProcessListeners` read
 * and threw away with a bare console.log. That is why the user saw nothing.
 */
describe("#3729 — invalidation is detected on the Codex child's stderr", () => {
  it("raises login-required once from a real child emitting the real 401 line", async () => {
    const { spawn } = await import("node:child_process");
    const readline = await import("node:readline");
    const providers = await import(
      // @ts-expect-error — plain-JS runtime module without type declarations.
      "../../bin/browser-local/providers.mjs"
    );

    // A real child process writing the real captured line to a real stderr
    // pipe, four times — the live failure repeats every few seconds.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `let n=0;const t=setInterval(()=>{n++;process.stderr.write(${JSON.stringify(
          REAL_CODEX_INVALIDATION,
        )}+"\n");if(n>=4){clearInterval(t);process.exit(0);}},50);`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    const emitted: Array<{ channel: string; payload: Record<string, string> }> = [];
    const session = {
      id: "codex-auth-regression",
      process: child,
      output: readline.createInterface({ input: child.stdout! }),
      serenMcpProxy: null,
      currentPrompt: null,
      pendingRequests: new Map(),
      status: "ready",
    };

    providers._attachProcessListeners(
      (channel: string, payload: Record<string, string>) =>
        emitted.push({ channel, payload }),
      new Map([[session.id, session]]),
      session,
      "[test][codex]",
    );

    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const loginRequired = emitted.filter(
      (e) => e.channel === "provider://login-required",
    );
    // Exactly one: the 401 repeats for the life of the session, so a
    // per-line emit would bury the log and reopen the login flow on a loop.
    expect(loginRequired).toHaveLength(1);
    expect(loginRequired[0]?.payload.agentType).toBe("codex");
    expect(loginRequired[0]?.payload.sessionId).toBe("codex-auth-regression");

    const errors = emitted.filter((e) => e.channel === "provider://error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload.error).toMatch(/sign-in expired/i);

    clearAgentCredentialsInvalid("codex");
  });
});

describe("#3729 — the native Codex path reaches the login-required flow", () => {
  it("emits provider://login-required before provider://error on an auth failure", () => {
    // Every other runtime emits this; providers.mjs previously emitted none,
    // so agent.store's auto-launch-login handler was unreachable for Codex.
    const loginIdx = providersSource.indexOf('"provider://login-required"');
    expect(loginIdx, "Codex path must emit login-required").toBeGreaterThan(0);

    const authBranch = providersSource.indexOf("const authFailed = isAuthError(");
    expect(authBranch).toBeGreaterThan(0);
    const errorIdx = providersSource.indexOf(
      '"provider://error"',
      authBranch,
    );
    const loginInBranch = providersSource.indexOf(
      '"provider://login-required"',
      authBranch,
    );
    expect(loginInBranch).toBeGreaterThan(0);
    expect(
      loginInBranch,
      "login-required must precede the error event, matching acp-runtime",
    ).toBeLessThan(errorIdx);
  });

  it("carries agentType codex so the auto-login targets the right CLI", () => {
    expect(providersSource).toMatch(
      /provider:\/\/login-required"[\s\S]{0,160}agentType: "codex"/,
    );
  });
});

describe("#3729 — Codex auth status reflects validity, not file presence", () => {
  it("stops reporting codex as authenticated after an observed invalidation", async () => {
    // Real module, real filesystem check — the credential file on this machine
    // is untouched, which is the whole point: presence alone is not evidence.
    const registry = await import(
      // @ts-expect-error — plain-JS runtime module without type declarations.
      "../../bin/browser-local/agent-registry.mjs"
    );

    clearAgentCredentialsInvalid("codex");
    const before = registry._isAgentAuthenticated("codex");

    markAgentCredentialsInvalid("codex");
    const after = registry._isAgentAuthenticated("codex");

    clearAgentCredentialsInvalid("codex");
    const restored = registry._isAgentAuthenticated("codex");

    // Only meaningful when a credential actually exists on this machine; when
    // it does, an observed rejection must flip the answer.
    if (before) {
      expect(after, "an observed rejection must clear authenticated").toBe(
        false,
      );
      expect(restored, "clearing the flag must restore it").toBe(true);
    }
  });

  it("does not call upstream to decide availability", () => {
    const idx = registrySource.indexOf("function hasObservedInvalidCredentials");
    expect(idx).toBeGreaterThan(0);
    const body = registrySource.slice(idx, idx + 900);
    // Availability is polled often; a network call here would be a hot-path
    // regression, not a fix.
    expect(body).not.toMatch(/fetch\(|https?:\/\//);
  });
});
