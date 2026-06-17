import { randomUUID, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { WebSocket } from "ws";

const API_BASE = requiredEnv("SEREN_E2E_API_BASE", "https://api.serendb.com").replace(/\/$/, "");
const CDP_ENDPOINT = requiredEnv("SEREN_E2E_CDP_ENDPOINT");
const EMAIL = requiredEnv("SEREN_E2E_EMAIL");
const PASSWORD = requiredEnv("SEREN_E2E_PASSWORD");
const HISTORY_PROJECT_ID = requiredEnv("SEREN_E2E_HISTORY_PROJECT_ID");
const HISTORY_BRANCH_ID = requiredEnv("SEREN_E2E_HISTORY_BRANCH_ID");
const HISTORY_DATABASE_NAME = requiredEnv("SEREN_E2E_HISTORY_DATABASE_NAME");
const GITHUB_USERNAME = requiredEnv("SEREN_E2E_GITHUB_USERNAME");
const GITHUB_PASSWORD = requiredEnv("SEREN_E2E_GITHUB_PASSWORD");
const GITHUB_PAT = requiredEnv("SEREN_E2E_GITHUB_PAT");
const GITHUB_TOTP_SECRET = process.env.SEREN_E2E_GITHUB_TOTP_SECRET ?? "";
const OAUTH_PROVIDER = process.env.SEREN_E2E_OAUTH_PROVIDER ?? "github";
// The paired workflow ships as one agent type backed by two CLIs. Declared
// locally because the e2e payload only bundles this script — never bin/.
const PAIRED_AGENT_TYPE = "claude-codex";
// Every shipped subscription coding-agent journey is certified, not one
// env-selected type (#2375). Override with a comma list for ad-hoc runs.
const AGENT_JOURNEYS = (
  process.env.SEREN_E2E_AGENT_JOURNEYS ??
  `codex,claude-code,${PAIRED_AGENT_TYPE}`
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const AGENT_CWD = process.env.SEREN_E2E_AGENT_CWD ?? process.cwd();
// Pin the spawn model when set (e.g. a Bedrock inference-profile id for the
// Bedrock-backed claude-code journey). The runtime always forwards --model, so
// this is the only lever that reaches the CLI; unset means runtime default.
const AGENT_MODEL = process.env.SEREN_E2E_AGENT_MODEL?.trim() || null;
const PROMPT_TEXT =
  process.env.SEREN_E2E_AGENT_PROMPT ??
  "Reply with exactly SEREN_WINDOWS_E2E_OK and no other text.";
const CAPTURE_SECONDS = Number(process.env.SEREN_E2E_MEETING_CAPTURE_SECONDS ?? "8");

function requiredEnv(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function logStage(message) {
  console.log(`[windows-e2e] ${message}`);
}

async function waitUntil(label, fn, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function tauriInvoke(page, command, args = {}) {
  return page.evaluate(
    async ({ command: cmd, args: invokeArgs }) => {
      const internals = window.__TAURI_INTERNALS__;
      if (!internals?.invoke) {
        throw new Error("Tauri invoke bridge is not available in the WebView");
      }
      return await internals.invoke(cmd, invokeArgs);
    },
    { command, args },
  );
}

async function findSerenPage(browser) {
  return waitUntil(
    "Seren WebView page",
    async () => {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const url = page.url();
          if (!url.startsWith("devtools://") && !url.includes("/json/list")) {
            return page;
          }
        }
      }
      return null;
    },
    { timeoutMs: 45_000 },
  );
}

async function resolveCdpEndpoint(endpoint) {
  const versionUrl = `${endpoint.replace(/\/$/, "")}/json/version`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(versionUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const version = await response.json();
    if (
      typeof version.webSocketDebuggerUrl === "string" &&
      version.webSocketDebuggerUrl.trim() !== ""
    ) {
      console.log(`[windows-e2e] resolved CDP websocket endpoint from ${versionUrl}`);
      return version.webSocketDebuggerUrl;
    }
    throw new Error("missing webSocketDebuggerUrl");
  } catch (error) {
    console.warn(
      `[windows-e2e] unable to resolve CDP websocket endpoint from ${versionUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return endpoint;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectToApp() {
  const cdpEndpoint = await resolveCdpEndpoint(CDP_ENDPOINT);
  const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 120_000 });
  const page = await findSerenPage(browser);
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  await page.waitForLoadState("domcontentloaded");
  return { browser, page, browserErrors };
}

// The app exposes the same "Sign In" text/labels on three surfaces: the
// titlebar button, the account slide-panel form, and the session-expired
// modal form (z-1000, rendered last). Global `getByLabel`/`.last()` selectors
// race across all three, so bind every interaction to a single form (#2445).
async function dismissSessionExpiredModal(page) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  if (await dialog.isVisible().catch(() => false)) {
    await dialog
      .getByRole("button", { name: /^Dismiss$/ })
      .click({ timeout: 5_000 })
      .catch(() => {});
  }
}

async function signIn(page) {
  await tauriInvoke(page, "clear_token").catch(() => {});
  await tauriInvoke(page, "clear_refresh_token").catch(() => {});

  // A signed-out session must not surface the "session expired" modal (#2445);
  // dismiss it if a prior build still does so the panel form is the only one.
  await dismissSessionExpiredModal(page);

  const emailInput = page.getByLabel("Email");
  if (!(await emailInput.isVisible().catch(() => false))) {
    const signInButton = page.getByRole("button", { name: /^Sign In$/ }).first();
    await signInButton.click({ timeout: 10_000 });
  }

  // Scope to the one sign-in form so the submit is unambiguous.
  const form = page.locator("form").filter({ has: page.getByLabel("Email") });
  await form.getByLabel("Email").fill(EMAIL);
  await form.getByLabel("Password").fill(PASSWORD);
  await form.getByRole("button", { name: /^Sign In$/ }).click();

  const token = await waitUntil(
    "stored production auth token",
    async () => {
      const value = await tauriInvoke(page, "get_token").catch(() => null);
      return typeof value === "string" && value.length > 20 ? value : null;
    },
    { timeoutMs: 45_000 },
  );
  await validateSerenSession(token);
}

async function validateSerenSession(token) {
  const response = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(response.ok, `Production /auth/me failed after sign-in: HTTP ${response.status}`);
  const payload = await response.json();
  assert(payload?.data?.email, "Production /auth/me response did not include a user email");
  console.log(`[windows-e2e] Signed in to production as ${payload.data.email}`);
}

async function validateGithubPat() {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "seren-desktop-windows-e2e",
    },
  });
  assert(response.ok, `GitHub PAT validation failed: HTTP ${response.status}`);
  const body = await response.json();
  assert(body?.login, "GitHub PAT validation did not return a login");
  console.log(`[windows-e2e] GitHub PAT validated for ${body.login}`);
}

async function apiRequest(path, token, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
}

async function revokeOAuthConnection(token, provider = OAUTH_PROVIDER) {
  const response = await apiRequest(`/oauth/connections/${encodeURIComponent(provider)}`, token, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to revoke ${provider} OAuth connection: HTTP ${response.status}`);
  }
}

async function assertOAuthConnected(token, provider = OAUTH_PROVIDER) {
  return waitUntil(
    `${provider} OAuth connection`,
    async () => {
      const response = await apiRequest("/oauth/connections", token);
      if (!response.ok) {
        throw new Error(`list connections returned HTTP ${response.status}`);
      }
      const payload = await response.json();
      const connections = payload.connections ?? payload.data?.connections ?? [];
      return connections.find(
        (connection) =>
          connection.provider_slug === provider &&
          connection.is_valid !== false,
      );
    },
    { timeoutMs: 45_000 },
  );
}

async function startGatewayOAuth(page, token, provider = OAUTH_PROVIDER) {
  const redirectUri = "http://localhost:8787/oauth/callback";
  const authUrl = `${API_BASE}/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(
    redirectUri,
  )}`;
  const location = await tauriInvoke(page, "get_oauth_redirect_url", {
    url: authUrl,
    bearerToken: token,
  });
  assert(
    typeof location === "string" && location.startsWith("https://"),
    `Gateway returned invalid OAuth redirect URL for ${provider}`,
  );
  return location;
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  const bytes = [];
  for (const char of input.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid base32 character in TOTP secret");
    bits += value.toString(2).padStart(5, "0");
    while (bits.length >= 8) {
      bytes.push(Number.parseInt(bits.slice(0, 8), 2));
      bits = bits.slice(8);
    }
  }
  return Buffer.from(bytes);
}

function totp(secret, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

// Persist a screenshot and page HTML when the GitHub OAuth flow stalls. The
// SSM transport only echoes the run log, so without an on-disk artifact a
// GitHub UI change surfaces as an opaque timeout (#2509). Files land in the
// harness work dir and are retrievable from the e2e box.
async function captureOAuthFailureArtifacts(page, label) {
  const safe = label.replace(/[^a-z0-9-]/gi, "_");
  const base = `github-oauth-failure-${safe}`;
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    logStage(`captured OAuth failure screenshot ${base}.png`);
  } catch (error) {
    logStage(`could not capture OAuth screenshot: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await writeFile(`${base}.html`, await page.content(), "utf8");
    logStage(`captured OAuth failure HTML ${base}.html`);
  } catch (error) {
    logStage(`could not capture OAuth HTML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function completeGithubAuthorization(authUrl, label) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const login = page.locator("#login_field, input[name='login']").first();
    if (await login.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await login.fill(GITHUB_USERNAME);
      await page.locator("#password, input[name='password']").first().fill(GITHUB_PASSWORD);
      // Target the password form's submit, not a name regex: GitHub now also
      // renders a "Sign in with a passkey" <button>, so /sign in/i matched two
      // elements and tripped Playwright strict mode (#2527). The passkey is a
      // type="button", so the submit selector can't collide with it.
      await page
        .locator("input[type='submit'][name='commit'], button[type='submit']")
        .first()
        .click();
    }

    const otpInput = page
      .locator(
        "input[autocomplete='one-time-code'], input[name='otp'], input[name='app_otp'], input#app_totp, input#otp, input[inputmode='numeric']",
      )
      .first();
    if (await otpInput.isVisible({ timeout: 20_000 }).catch(() => false)) {
      assert(
        GITHUB_TOTP_SECRET,
        "GitHub requested two-factor auth but SEREN_E2E_GITHUB_TOTP_SECRET is not configured",
      );
      await otpInput.fill(totp(GITHUB_TOTP_SECRET));
      // GitHub's 2FA app page renders an explicit Verify button and does not
      // reliably submit on Enter (#2509); click it when present, else Enter.
      const verifyButton = page
        .getByRole("button", { name: /verify|confirm|continue|sign in/i })
        .or(page.locator("button[type='submit']"))
        .first();
      if (await verifyButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await verifyButton.click();
      } else {
        await page.keyboard.press("Enter");
      }
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    const authorizeButton = page
      .getByRole("button", { name: /authorize|continue|grant/i })
      .or(page.locator("button[name='authorize'], input[name='authorize']"))
      .first();
    if (await authorizeButton.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await authorizeButton.click();
    }

    await page.waitForURL(/localhost:8787\/oauth\/callback|127\.0\.0\.1:8787\/oauth\/callback|github\.com\/settings\/connections/, {
      timeout: 120_000,
    }).catch(async () => {
      const body = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      throw new Error(`GitHub OAuth did not reach the Seren callback. URL=${page.url()} Body=${body.slice(0, 500)}`);
    });
  } catch (error) {
    // Any failure in the GitHub flow — login, 2FA, authorize, or callback —
    // leaves a screenshot + page HTML in the work dir so the next github.com
    // UI change is a quick fix, not a hand-pulled on-box log (#2527). The
    // earlier login-button failure produced no artifact because capture was
    // scoped only to the callback timeout.
    await captureOAuthFailureArtifacts(page, label);
    throw error;
  } finally {
    await browser.close();
  }
}

async function exerciseOAuthReconnect(page) {
  const token = await tauriInvoke(page, "get_token");
  await validateGithubPat();
  await revokeOAuthConnection(token);

  for (const phase of ["connect", "reconnect"]) {
    const authUrl = await startGatewayOAuth(page, token);
    await completeGithubAuthorization(authUrl, phase);
    const connection = await assertOAuthConnected(token);
    console.log(`[windows-e2e] GitHub OAuth ${phase} valid for ${connection.provider_email ?? connection.provider_slug}`);
    await revokeOAuthConnection(token);
  }
}

function createRuntimeBuffer(ws) {
  const messages = [];
  const waiters = new Set();
  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!message?.method) return;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });
  return {
    mark: () => messages.length,
    slice: (from) => messages.slice(from),
    waitFor(predicate, timeoutMs, from = 0) {
      const existing = messages.slice(from).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timeout: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error("Timed out waiting for provider runtime event"));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function rpc(ws, method, params = {}, { timeoutMs = 0, label = method } = {}) {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const cleanup = () => {
      ws.off("message", onMessage);
      if (timer) {
        clearTimeout(timer);
      }
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch (error) {
        settle(reject, error);
        return;
      }
      if (message.id !== id) return;
      if (message.error) {
        settle(
          reject,
          new Error(String(message.error.message ?? "Provider runtime RPC failed")),
        );
        return;
      }
      settle(resolve, message.result);
    };
    ws.on("message", onMessage);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        settle(
          reject,
          new Error(`Timed out after ${timeoutMs}ms waiting for ${label} (${method})`),
        );
      }, timeoutMs);
    }
    try {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch (error) {
      settle(reject, error);
    }
  });
}

function rpcWithTimeout(
  ws,
  method,
  params = {},
  timeoutMs = PROVIDER_RPC_TIMEOUT_MS,
  label = method,
) {
  return rpc(ws, method, params, { timeoutMs, label });
}

function waitForWebSocketOpen(ws) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${PROVIDER_WS_OPEN_TIMEOUT_MS}ms waiting for provider runtime WebSocket open`,
        ),
      );
    }, PROVIDER_WS_OPEN_TIMEOUT_MS);
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

async function connectProviderRuntime(config) {
  logStage(`Waiting for provider runtime health at ${config.apiBaseUrl}`);
  const health = await waitUntil(
    "provider runtime health",
    async () => {
      const response = await fetch(`${config.apiBaseUrl}/__seren/health`);
      return response.ok ? response.json() : null;
    },
    { timeoutMs: 45_000 },
  );
  assert(health.mode === "desktop-native", `Unexpected provider runtime mode: ${health.mode}`);
  logStage("Provider runtime health OK; connecting WebSocket");
  const ws = new WebSocket(config.wsBaseUrl);
  await waitForWebSocketOpen(ws);
  logStage("Authenticating provider runtime WebSocket");
  await rpcWithTimeout(
    ws,
    "auth",
    { token: config.token },
    PROVIDER_RPC_TIMEOUT_MS,
    "provider runtime auth",
  );
  logStage("Provider runtime WebSocket authenticated");
  return ws;
}

function assistantText(buffer, marker, sessionId) {
  return buffer
    .slice(marker)
    .filter(
      (message) =>
        message.method === "provider://message-chunk" &&
        message.params?.sessionId === sessionId &&
        message.params?.isThought !== true,
    )
    .map((message) => String(message.params?.text ?? ""))
    .join("");
}

const SINGLE_PROMPT_TIMEOUT_MS = 240_000;
// The paired pipeline is three inner turns (plan → execute → review), so it
// needs a wider ceiling than a single prompt.
const PAIRED_PROMPT_TIMEOUT_MS = 600_000;
const PROVIDER_CONFIG_TIMEOUT_MS = 30_000;
const PROVIDER_WS_OPEN_TIMEOUT_MS = 30_000;
const PROVIDER_RPC_TIMEOUT_MS = 60_000;
const PROVIDER_ENSURE_CLI_TIMEOUT_MS = 600_000;
const PROVIDER_SPAWN_TIMEOUT_MS = 150_000;
const PROVIDER_TERMINATE_TIMEOUT_MS = 15_000;

// Both the Claude and Codex runtimes collapse auth failures to this text
// (claude-runtime/providers.mjs isAuthError). Detecting it lets an expired or
// unprovisioned credential read as "login expired" instead of a generic
// spawn/timeout failure (#2375).
const AUTH_FAILURE_PATTERNS = [
  "authentication required",
  "run the login flow",
  "please run /login",
  "login required",
  "not logged in",
  "please login",
  "please sign in",
  "session expired",
  "re-authenticate",
  "invalid api key",
];

const AGENT_PROCESS_EXIT_PATTERNS = [
  "app server stopped before request completed",
  "cli not found",
  "failed to install",
  "not recognized as the name",
  "worker thread dropped while prompt was active",
];

function isAuthFailureMessage(message) {
  const lower = String(message ?? "").toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isAgentProcessExitMessage(message) {
  const lower = String(message ?? "").toLowerCase();
  return AGENT_PROCESS_EXIT_PATTERNS.some((pattern) => lower.includes(pattern));
}

class AgentAuthError extends Error {}
class AgentProvisioningError extends Error {}

function authError(journey, detail) {
  return new AgentAuthError(
    `${journey} CLI is installed but not authenticated on the Windows e2e host ` +
      `(login expired or never provisioned). Refresh the credential via the ` +
      `WINDOWS_E2E_SECRET_PARAMETER_PREFIX SSM mechanism. If the harness runs ` +
      `as a scheduled-task user, ensure SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_S3_URI ` +
      `or SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_B64 hydrates that temporary profile. ` +
      `Detail: ${detail}`,
  );
}

function provisioningError(journey, detail) {
  return new AgentProvisioningError(
    `${journey} CLI could not be installed, launched, or kept alive long ` +
      `enough to complete the Windows e2e prompt. Verify the scheduled-task ` +
      `user can resolve the CLI binary and received agent credentials via ` +
      `SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_S3_URI or ` +
      `SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_B64, and check provider-runtime logs ` +
      `for a real process crash. Detail: ${detail}`,
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function shortSessionId(sessionId) {
  return String(sessionId ?? "").slice(0, 8) || "<none>";
}

function redactUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<unparseable>";
  }
}

function summarizeProviderRuntimeEvents(buffer, marker, sessionIds) {
  const ids = new Set(sessionIds.filter(Boolean));
  const events = buffer
    .slice(marker)
    .filter((event) => {
      if (!event?.method) return false;
      const sessionId = event.params?.sessionId;
      return ids.size === 0 || !sessionId || ids.has(sessionId);
    })
    .slice(-10)
    .map((event) => {
      const params = event.params ?? {};
      const session = params.sessionId
        ? ` session=${shortSessionId(params.sessionId)}`
        : "";
      const kind = params.kind ? ` kind=${params.kind}` : "";
      const status = params.status ? ` status=${params.status}` : "";
      const paired = params.paired?.state ? ` paired=${params.paired.state}` : "";
      const error = params.error
        ? ` error=${String(params.error).slice(0, 160)}`
        : "";
      return `${event.method}${session}${kind}${status}${paired}${error}`;
    });
  return events.length > 0 ? events.join(" | ") : "<no provider runtime events captured>";
}

async function ensureAgentCli(ws, agentType) {
  try {
    logStage(`${agentType} ensuring provider CLI`);
    const resolved = await rpcWithTimeout(
      ws,
      "provider_ensure_agent_cli",
      { agentType },
      PROVIDER_ENSURE_CLI_TIMEOUT_MS,
      `${agentType} CLI install`,
    );
    logStage(`${agentType} provider CLI ready: ${String(resolved || "<unknown>")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw provisioningError(agentType, message);
  }
}

// A raw spawn/prompt failure carries a generic message; the runtime also emits
// a provider://error with the auth text. Promote either signal to a distinct
// AgentAuthError so the job names the credential gap, not a timeout (#2375).
function classifyJourneyError(journey, error, buffer, marker, sessionIds) {
  if (error instanceof AgentAuthError) return error;
  if (error instanceof AgentProvisioningError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (isAuthFailureMessage(message)) return authError(journey, message);
  if (isAgentProcessExitMessage(message)) return provisioningError(journey, message);
  const ids = sessionIds.filter(Boolean);
  const journeyEvents = buffer
    .slice(marker)
    .filter(
      (event) =>
        event.method === "provider://error" &&
        ids.includes(event.params?.sessionId),
    );
  const authEvent = journeyEvents.find((event) =>
    isAuthFailureMessage(event.params?.error),
  );
  if (authEvent) return authError(journey, String(authEvent.params.error));
  const processExitEvent = journeyEvents.find((event) =>
    isAgentProcessExitMessage(event.params?.error),
  );
  if (processExitEvent) {
    return provisioningError(journey, String(processExitEvent.params.error));
  }
  if (message.startsWith("Timed out after")) {
    return new Error(
      `${message}. Last provider runtime events: ${summarizeProviderRuntimeEvents(
        buffer,
        marker,
        ids,
      )}`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function runSingleAgentJourney(ws, buffer, agentType) {
  const localSessionId = randomUUID();
  const marker = buffer.mark();
  let session;
  try {
    logStage(`${agentType} journey starting`);
    await ensureAgentCli(ws, agentType);
    logStage(`${agentType} checking provider availability`);
    const available = await rpcWithTimeout(
      ws,
      "provider_check_agent_available",
      { agentType },
      PROVIDER_RPC_TIMEOUT_MS,
      `${agentType} availability check`,
    );
    assert(available === true, `${agentType} is not available on the Windows e2e host`);
    logStage(`${agentType} checking provider authentication`);
    const authenticated = await rpcWithTimeout(
      ws,
      "provider_check_agent_authenticated",
      { agentType },
      PROVIDER_RPC_TIMEOUT_MS,
      `${agentType} authentication check`,
    );
    if (authenticated !== true) {
      throw authError(
        agentType,
        "provider_check_agent_authenticated returned false before prompt",
      );
    }
    logStage(`${agentType} spawning provider session`);
    session = await rpcWithTimeout(
      ws,
      "provider_spawn",
      {
        agentType,
        cwd: AGENT_CWD,
        localSessionId,
        resumeAgentSessionId: null,
        sandboxMode: "workspace-write",
        apiKey: null,
        approvalPolicy: agentType === "codex" ? "never" : "on-request",
        searchEnabled: false,
        networkEnabled: true,
        timeoutSecs: 120,
        initialModelId: AGENT_MODEL ?? undefined,
      },
      PROVIDER_SPAWN_TIMEOUT_MS,
      `${agentType} spawn`,
    );
    assert(session?.id, `${agentType} provider_spawn did not return a local session id`);
    logStage(`${agentType} provider session spawned: ${shortSessionId(session.id)}`);
    // The prompt RPC resolves only when the turn completes (or rejects on an
    // auth/runtime error), so the wait bounds the whole turn.
    logStage(`${agentType} prompt started`);
    await rpcWithTimeout(
      ws,
      "provider_prompt",
      {
        sessionId: session.id,
        prompt: PROMPT_TEXT,
        context: null,
      },
      SINGLE_PROMPT_TIMEOUT_MS,
      `${agentType} prompt`,
    );
    logStage(`${agentType} prompt RPC completed`);
    await buffer.waitFor(
      (message) =>
        message.method === "provider://prompt-complete" &&
        message.params?.sessionId === session.id &&
        message.params?.historyReplay !== true,
      30_000,
      marker,
    );
    logStage(`${agentType} prompt-complete event observed`);
    const text = assistantText(buffer, marker, session.id);
    assert(
      text.includes("SEREN_WINDOWS_E2E_OK"),
      `${agentType} response did not include expected marker. Text=${text.slice(0, 500)}`,
    );
    console.log(`[windows-e2e] ${agentType} stream-json runtime prompt completed`);
  } catch (error) {
    throw classifyJourneyError(agentType, error, buffer, marker, [
      localSessionId,
      session?.id,
    ]);
  } finally {
    if (session?.id) {
      logStage(`${agentType} terminating provider session ${shortSessionId(session.id)}`);
      await rpcWithTimeout(
        ws,
        "provider_terminate",
        { sessionId: session.id },
        PROVIDER_TERMINATE_TIMEOUT_MS,
        `${agentType} terminate`,
      ).catch((error) => {
        console.warn(
          `[windows-e2e] ${agentType} provider_terminate failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }
}

async function runPairedJourney(ws, buffer) {
  const localSessionId = randomUUID();
  const marker = buffer.mark();
  let session;
  try {
    logStage(`${PAIRED_AGENT_TYPE} journey starting`);
    await ensureAgentCli(ws, PAIRED_AGENT_TYPE);
    logStage(`${PAIRED_AGENT_TYPE} checking provider availability`);
    const available = await rpcWithTimeout(
      ws,
      "provider_check_agent_available",
      { agentType: PAIRED_AGENT_TYPE },
      PROVIDER_RPC_TIMEOUT_MS,
      `${PAIRED_AGENT_TYPE} availability check`,
    );
    assert(available === true, `${PAIRED_AGENT_TYPE} is not available on the Windows e2e host`);
    logStage(`${PAIRED_AGENT_TYPE} checking provider authentication`);
    const authenticated = await rpcWithTimeout(
      ws,
      "provider_check_agent_authenticated",
      { agentType: PAIRED_AGENT_TYPE },
      PROVIDER_RPC_TIMEOUT_MS,
      `${PAIRED_AGENT_TYPE} authentication check`,
    );
    if (authenticated !== true) {
      throw authError(
        PAIRED_AGENT_TYPE,
        "provider_check_agent_authenticated returned false before prompt",
      );
    }
    logStage(`${PAIRED_AGENT_TYPE} spawning provider session`);
    session = await rpcWithTimeout(
      ws,
      "provider_spawn",
      {
        agentType: PAIRED_AGENT_TYPE,
        cwd: AGENT_CWD,
        localSessionId,
        resumeAgentSessionId: null,
        sandboxMode: "workspace-write",
        apiKey: null,
        // "never" keeps the Codex executor from stalling on an approval that no
        // operator is present to grant during the headless run.
        approvalPolicy: "never",
        searchEnabled: false,
        networkEnabled: true,
        timeoutSecs: 120,
      },
      PROVIDER_SPAWN_TIMEOUT_MS,
      `${PAIRED_AGENT_TYPE} spawn`,
    );
    assert(session?.id, "paired provider_spawn did not return a local session id");
    logStage(`${PAIRED_AGENT_TYPE} provider session spawned: ${shortSessionId(session.id)}`);

    // The setup declaration is the first paired transcript event, emitted at
    // spawn for a fresh thread. Role model/effort echoes refresh it in place
    // (replace=true) — those refreshes are expected, the append is not.
    const declarations = buffer
      .slice(marker)
      .filter(
        (event) =>
          event.method === "provider://paired-event" &&
          event.params?.sessionId === session.id &&
          event.params?.kind === "declaration",
      );
    assert(
      declarations.length >= 1,
      "paired session did not emit a setup declaration at spawn",
    );
    assert(
      declarations[0].params?.replace !== true,
      "first paired declaration must be an append, not a replace",
    );
    assert(
      declarations.slice(1).every((event) => event.params?.replace === true),
      "paired declaration refreshes after the first must replace in place",
    );

    const promptMark = buffer.mark();
    logStage(`${PAIRED_AGENT_TYPE} prompt started`);
    await rpcWithTimeout(
      ws,
      "provider_prompt",
      {
        sessionId: session.id,
        prompt: PROMPT_TEXT,
        context: null,
      },
      PAIRED_PROMPT_TIMEOUT_MS,
      "claude-codex paired prompt",
    );
    logStage(`${PAIRED_AGENT_TYPE} prompt RPC completed`);

    const turnEvents = buffer.slice(promptMark);
    const completes = turnEvents.filter(
      (event) =>
        event.method === "provider://prompt-complete" &&
        event.params?.sessionId === session.id,
    );
    assert(
      completes.length === 1,
      `paired turn must emit exactly one prompt-complete, got ${completes.length}`,
    );
    logStage(`${PAIRED_AGENT_TYPE} prompt-complete event observed`);

    const handoffs = turnEvents.filter(
      (event) =>
        event.method === "provider://paired-event" &&
        event.params?.sessionId === session.id &&
        event.params?.kind === "handoff",
    );
    assert(handoffs.length === 2, `paired turn must emit two handoffs, got ${handoffs.length}`);
    assert(
      handoffs[0].params?.from === "Claude" && handoffs[0].params?.to === "Codex",
      "first paired handoff must be Claude → Codex",
    );
    assert(
      handoffs[1].params?.from === "Codex" && handoffs[1].params?.to === "Claude",
      "second paired handoff must be Codex → Claude",
    );

    // Every status frame emitted while a phase is active must carry
    // "prompting"; a mid-turn "ready" re-enables Send and collides the next
    // submit with this turn (#2372). The trailing idle frame is "ready".
    const phaseFrames = turnEvents.filter(
      (event) =>
        event.method === "provider://session-status" &&
        event.params?.sessionId === session.id &&
        ["planning", "executing", "reviewing"].includes(
          event.params?.paired?.state,
        ),
    );
    assert(
      phaseFrames.length > 0,
      "paired turn emitted no active-phase status frames",
    );
    assert(
      phaseFrames.every((event) => event.params?.status === "prompting"),
      `paired turn must hold status "prompting" across phases (#2372); saw ${phaseFrames
        .map((event) => `${event.params?.paired?.state}:${event.params?.status}`)
        .join(",")}`,
    );

    console.log(
      `[windows-e2e] ${PAIRED_AGENT_TYPE} paired pipeline verified: declaration + 2 handoffs + single prompt-complete, prompting held across phases`,
    );
  } catch (error) {
    throw classifyJourneyError(PAIRED_AGENT_TYPE, error, buffer, marker, [
      localSessionId,
      session?.id,
    ]);
  } finally {
    if (session?.id) {
      logStage(`${PAIRED_AGENT_TYPE} terminating provider session ${shortSessionId(session.id)}`);
      await rpcWithTimeout(
        ws,
        "provider_terminate",
        { sessionId: session.id },
        PROVIDER_TERMINATE_TIMEOUT_MS,
        `${PAIRED_AGENT_TYPE} terminate`,
      ).catch((error) => {
        console.warn(
          `[windows-e2e] ${PAIRED_AGENT_TYPE} provider_terminate failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }
}

async function exerciseAgentRuntime(page) {
  logStage("Resolving provider runtime config");
  const config = await withTimeout(
    tauriInvoke(page, "provider_runtime_get_config"),
    PROVIDER_CONFIG_TIMEOUT_MS,
    "provider runtime config",
  );
  assert(config?.apiBaseUrl && config?.wsBaseUrl && config?.token, "provider runtime config missing fields");
  logStage(
    `Provider runtime config resolved: api=${redactUrl(config.apiBaseUrl)} ws=${redactUrl(config.wsBaseUrl)}`,
  );
  const ws = await connectProviderRuntime(config);
  const buffer = createRuntimeBuffer(ws);
  try {
    for (const journey of AGENT_JOURNEYS) {
      if (journey === PAIRED_AGENT_TYPE) {
        await runPairedJourney(ws, buffer);
      } else {
        await runSingleAgentJourney(ws, buffer, journey);
      }
    }
    console.log(`[windows-e2e] all agent journeys verified: ${AGENT_JOURNEYS.join(", ")}`);
  } finally {
    ws.close();
  }
}

async function createConversationWithMessage(page, label) {
  const conversationId = `windows-e2e-${label}-${randomUUID()}`;
  const timestamp = Date.now();
  await tauriInvoke(page, "create_conversation", {
    id: conversationId,
    title: `Windows e2e ${label}`,
    selectedModel: null,
    selectedProvider: "seren",
    projectRoot: null,
    employeeId: null,
  });
  await tauriInvoke(page, "save_message", {
    id: randomUUID(),
    conversationId,
    role: "user",
    content: `history-sync ${label} ${timestamp}`,
    model: null,
    timestamp,
    metadata: null,
    provider: "seren",
  });
  return conversationId;
}

async function runHistorySync(page, label) {
  const summary = await tauriInvoke(page, "history_sync_run_now", {
    projectId: HISTORY_PROJECT_ID,
    branchId: HISTORY_BRANCH_ID,
    databaseName: HISTORY_DATABASE_NAME,
  });
  assert(summary.conflicts === 0, `${label} history sync reported conflicts`);
  assert(summary.queued === 0, `${label} history sync left queued rows`);
  assert(summary.pushed > 0 || summary.pulled > 0 || summary.backfilled > 0, `${label} history sync moved no rows`);
  console.log(`[windows-e2e] history sync ${label}: ${JSON.stringify(summary)}`);
  return summary;
}

async function exerciseHistorySync(page) {
  await createConversationWithMessage(page, "before-wipe");
  await runHistorySync(page, "initial");
  await tauriInvoke(page, "history_sync_wipe_remote", {
    projectId: HISTORY_PROJECT_ID,
    branchId: HISTORY_BRANCH_ID,
    databaseName: HISTORY_DATABASE_NAME,
    confirmation: HISTORY_DATABASE_NAME,
  });
  await createConversationWithMessage(page, "after-wipe");
  await runHistorySync(page, "after-wipe-resync");
}

function playWindowsAudio() {
  const command = [
    "[Console]::Beep(880, 1200)",
    "Start-Sleep -Milliseconds 250",
    "[Console]::Beep(660, 1200)",
    "Start-Sleep -Milliseconds 250",
    "[Console]::Beep(990, 1200)",
  ].join("; ");
  return spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    stdio: "ignore",
  });
}

async function exerciseMeetingCapture(page) {
  const meeting = await tauriInvoke(page, "create_meeting", {
    title: `Windows e2e capture ${new Date().toISOString()}`,
    sourceApp: "windows-e2e",
    startedAt: Date.now(),
    templateId: null,
  });
  assert(meeting?.id, "create_meeting did not return an id");
  await tauriInvoke(page, "start_meeting_capture", { meetingId: meeting.id });
  const audio = playWindowsAudio();
  await sleep(CAPTURE_SECONDS * 1000);
  const outcome = await tauriInvoke(page, "stop_meeting_capture", {
    meetingId: meeting.id,
  });
  audio.kill();
  assert(outcome.hadCapture === true, "meeting capture reported hadCapture=false");
  assert(
    outcome.nativeMicReady === true || outcome.systemAudioReady === true,
    `meeting capture had no native mic or system audio ready: ${JSON.stringify(outcome)}`,
  );
  assert(
    outcome.nativeMicFrameCount > 0 ||
      outcome.systemAudioFrameCount > 0 ||
      outcome.frameCount > 0,
    `meeting capture recorded no frames: ${JSON.stringify(outcome)}`,
  );
  assert(!outcome.failureReason, `meeting capture failed: ${outcome.failureReason}`);
  console.log(
    `[windows-e2e] meeting capture frames mic=${outcome.nativeMicFrameCount} system=${outcome.systemAudioFrameCount}`,
  );
}

async function main() {
  const { browser, page, browserErrors } = await connectToApp();
  try {
    await signIn(page);
    await exerciseAgentRuntime(page);
    await exerciseHistorySync(page);
    await exerciseOAuthReconnect(page);
    await exerciseMeetingCapture(page);
    assert(browserErrors.length === 0, `WebView console/page errors: ${browserErrors.join("\n")}`);
    console.log("[windows-e2e] full Windows production e2e passed");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
