import { randomUUID, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
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
const AGENT_TYPE = process.env.SEREN_E2E_AGENT_TYPE ?? "codex";
const AGENT_CWD = process.env.SEREN_E2E_AGENT_CWD ?? process.cwd();
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

async function connectToApp() {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
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

async function signIn(page) {
  await tauriInvoke(page, "clear_token").catch(() => {});
  await tauriInvoke(page, "clear_refresh_token").catch(() => {});

  const emailInput = page.getByLabel("Email");
  if (!(await emailInput.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const signInButton = page.getByRole("button", { name: /^Sign In$/ }).first();
    await signInButton.click({ timeout: 10_000 });
  }

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /^Sign In$/ }).last().click();

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

async function completeGithubAuthorization(authUrl) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const login = page.locator("#login_field, input[name='login']").first();
    if (await login.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await login.fill(GITHUB_USERNAME);
      await page.locator("#password, input[name='password']").first().fill(GITHUB_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();
    }

    const otpInput = page.locator("input[name='otp'], input#app_otp, input[autocomplete='one-time-code']").first();
    if (await otpInput.isVisible({ timeout: 8_000 }).catch(() => false)) {
      assert(
        GITHUB_TOTP_SECRET,
        "GitHub requested two-factor auth but SEREN_E2E_GITHUB_TOTP_SECRET is not configured",
      );
      await otpInput.fill(totp(GITHUB_TOTP_SECRET));
      await page.keyboard.press("Enter");
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
    await completeGithubAuthorization(authUrl);
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

function rpc(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch (error) {
        ws.off("message", onMessage);
        reject(error);
        return;
      }
      if (message.id !== id) return;
      ws.off("message", onMessage);
      if (message.error) {
        reject(new Error(String(message.error.message ?? "Provider runtime RPC failed")));
        return;
      }
      resolve(message.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function connectProviderRuntime(config) {
  const health = await waitUntil(
    "provider runtime health",
    async () => {
      const response = await fetch(`${config.apiBaseUrl}/__seren/health`);
      return response.ok ? response.json() : null;
    },
    { timeoutMs: 45_000 },
  );
  assert(health.mode === "desktop-native", `Unexpected provider runtime mode: ${health.mode}`);
  const ws = new WebSocket(config.wsBaseUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await rpc(ws, "auth", { token: config.token });
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

async function exerciseAgentRuntime(page) {
  const config = await tauriInvoke(page, "provider_runtime_get_config");
  assert(config?.apiBaseUrl && config?.wsBaseUrl && config?.token, "provider runtime config missing fields");
  const ws = await connectProviderRuntime(config);
  const buffer = createRuntimeBuffer(ws);
  let session;
  try {
    const available = await rpc(ws, "provider_check_agent_available", { agentType: AGENT_TYPE });
    assert(available === true, `${AGENT_TYPE} is not available on the Windows e2e host`);
    session = await rpc(ws, "provider_spawn", {
      agentType: AGENT_TYPE,
      cwd: AGENT_CWD,
      localSessionId: randomUUID(),
      resumeAgentSessionId: null,
      sandboxMode: "workspace-write",
      apiKey: null,
      approvalPolicy: AGENT_TYPE === "codex" ? "never" : "on-request",
      searchEnabled: false,
      networkEnabled: true,
      timeoutSecs: 120,
    });
    assert(session?.id, "provider_spawn did not return a local session id");
    const marker = buffer.mark();
    await rpc(ws, "provider_prompt", {
      sessionId: session.id,
      prompt: PROMPT_TEXT,
      context: null,
    });
    await buffer.waitFor(
      (message) =>
        message.method === "provider://prompt-complete" &&
        message.params?.sessionId === session.id &&
        message.params?.historyReplay !== true,
      240_000,
      marker,
    );
    const text = assistantText(buffer, marker, session.id);
    assert(
      text.includes("SEREN_WINDOWS_E2E_OK"),
      `Agent response did not include expected marker. Text=${text.slice(0, 500)}`,
    );
    console.log(`[windows-e2e] ${AGENT_TYPE} stream-json runtime prompt completed`);
  } finally {
    if (session?.id) {
      await rpc(ws, "provider_terminate", { sessionId: session.id }).catch(() => {});
    }
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
