import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { WebSocket } from "ws";

const API_BASE = requiredEnv("SEREN_E2E_API_BASE", "https://api.serendb.com").replace(/\/$/, "");
const CDP_ENDPOINT = requiredEnv("SEREN_E2E_CDP_ENDPOINT");
const EMAIL = requiredEnv("SEREN_E2E_EMAIL");
const PASSWORD = requiredEnv("SEREN_E2E_PASSWORD");
const HISTORY_PROJECT_ID = optionalEnv("SEREN_E2E_HISTORY_PROJECT_ID");
const HISTORY_BRANCH_ID = optionalEnv("SEREN_E2E_HISTORY_BRANCH_ID");
const HISTORY_PROJECT_NAME =
  optionalEnv("SEREN_E2E_HISTORY_PROJECT_NAME") ?? "windows-e2e-history";
const HISTORY_BRANCH_NAME =
  optionalEnv("SEREN_E2E_HISTORY_BRANCH_NAME") ?? "production";
const HISTORY_DATABASE_NAME =
  optionalEnv("SEREN_E2E_HISTORY_DATABASE_NAME") ?? "windows_e2e_history";
const HISTORY_REGION = optionalEnv("SEREN_E2E_HISTORY_REGION") ?? "aws-us-east-2";
const HISTORY_SYNC_READY_ATTEMPTS = Number(
  process.env.SEREN_E2E_HISTORY_READY_ATTEMPTS ?? "90",
);
const HISTORY_SYNC_READY_DELAY_MS = Number(
  process.env.SEREN_E2E_HISTORY_READY_DELAY_MS ?? "2000",
);
const GITHUB_PAT = requiredEnv("SEREN_E2E_GITHUB_PAT");
// The paired workflow ships as one agent type backed by two CLIs. Declared
// locally because the e2e payload only bundles this script — never bin/.
const PAIRED_AGENT_TYPE = "claude-codex";
// npm-backed CLIs are installed and version-checked by the disposable Windows
// test-user setup before the app starts. Exercise the production resolver for
// every corresponding provider here without requiring credentials or turning
// provider_ensure_agent_cli back into an installer. LM Studio is excluded:
// its `lms` CLI ships with the separately installed LM Studio application.
const CLI_COMPATIBILITY_AGENT_TYPES = [
  "codex",
  "claude-code",
  PAIRED_AGENT_TYPE,
  "gemini",
  "grok",
];
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

function optionalEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function logStage(message) {
  console.log(`[windows-e2e] ${message}`);
}

function isTransientProviderRuntimeStartupError(message) {
  return /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/?' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/.test(
    message,
  );
}

function assertNoUnexpectedBrowserErrors(browserErrors) {
  const unexpectedErrors = browserErrors.filter(
    (message) => !isTransientProviderRuntimeStartupError(message),
  );
  const ignoredCount = browserErrors.length - unexpectedErrors.length;
  if (ignoredCount > 0) {
    console.log(
      `[windows-e2e] ignored ${ignoredCount} transient provider runtime startup WebSocket error(s) after runtime auth succeeded`,
    );
  }
  assert(
    unexpectedErrors.length === 0,
    `WebView console/page errors: ${unexpectedErrors.join("\n")}`,
  );
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

async function submitSignInForm(form) {
  const submitButton = form.getByRole("button", { name: /^Sign In$/ });
  await waitUntil(
    "enabled sign-in submit button",
    async () => ((await submitButton.isEnabled().catch(() => false)) ? true : null),
    { timeoutMs: 10_000 },
  );
  await submitButton.evaluate((button) => {
    const form = button.closest("form");
    if (!form) {
      throw new Error("Sign-in submit button is not inside a form");
    }
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit(button);
      return;
    }
    button.click();
  });
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
  await submitSignInForm(form);

  const token = await waitUntil(
    "stored production auth token",
    async () => {
      const value = await tauriInvoke(page, "get_token").catch(() => null);
      return typeof value === "string" && value.length > 20 ? value : null;
    },
    { timeoutMs: 45_000 },
  );
  await validateSerenSession(token);
  return token;
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

class SerenDbApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SerenDbApiError";
    this.status = status;
  }
}

function pathSegment(value) {
  return encodeURIComponent(value);
}

function describeSerenDbPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidate =
    payload.message ??
    payload.error ??
    payload.detail ??
    payload.data?.message ??
    payload.data?.error;
  return typeof candidate === "string" && candidate.trim() !== ""
    ? candidate.trim().slice(0, 200)
    : "";
}

async function serenDbRequest(
  token,
  path,
  { method = "GET", body, acceptedStatuses = [200] } = {},
) {
  const response = await fetch(`${API_BASE}/publishers/seren-db${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  if (text.trim() !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!acceptedStatuses.includes(response.status)) {
    const detail = describeSerenDbPayload(payload);
    throw new SerenDbApiError(
      `${method} ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  return payload?.data;
}

function requireDataArray(value, label) {
  if (Array.isArray(value)) return value;
  throw new Error(`${label} response did not include an array`);
}

async function listHistoryProjects(token) {
  return requireDataArray(await serenDbRequest(token, "/projects"), "list projects");
}

async function listHistoryBranches(token, projectId) {
  return requireDataArray(
    await serenDbRequest(token, `/projects/${pathSegment(projectId)}/branches`),
    "list branches",
  );
}

async function listHistoryDatabases(token, projectId, branchId) {
  return requireDataArray(
    await serenDbRequest(
      token,
      `/projects/${pathSegment(projectId)}/branches/${pathSegment(branchId)}/databases`,
    ),
    "list databases",
  );
}

async function fetchHistoryConnectionString(token, destination) {
  const data = await serenDbRequest(
    token,
    `/projects/${pathSegment(destination.projectId)}/branches/${pathSegment(
      destination.branchId,
    )}/connection-string?pooled=true`,
  );
  assert(
    typeof data?.connection_string === "string" && data.connection_string.length > 0,
    "history connection-string response did not include connection_string",
  );
}

async function createHistoryProject(token) {
  const data = await serenDbRequest(token, "/projects", {
    method: "POST",
    body: { name: HISTORY_PROJECT_NAME, region: HISTORY_REGION },
    acceptedStatuses: [200, 201],
  });
  assert(data?.id, "create project response did not include an id");
  return data;
}

async function createHistoryBranch(token, projectId) {
  const data = await serenDbRequest(token, `/projects/${pathSegment(projectId)}/branches`, {
    method: "POST",
    body: { name: HISTORY_BRANCH_NAME, add_endpoint: true },
    acceptedStatuses: [200, 201],
  });
  const branch = data?.branch ?? data;
  assert(branch?.id, "create branch response did not include a branch id");
  return branch;
}

async function createHistoryDatabase(token, projectId, branchId) {
  const data = await serenDbRequest(
    token,
    `/projects/${pathSegment(projectId)}/branches/${pathSegment(branchId)}/databases`,
    {
      method: "POST",
      body: { name: HISTORY_DATABASE_NAME, owner_name: null },
      acceptedStatuses: [200, 201],
    },
  );
  assert(data?.id || data?.name, "create database response did not include database data");
  return data;
}

async function ensureNamedHistoryProject(token) {
  const existing = (await listHistoryProjects(token)).find(
    (project) => project?.name === HISTORY_PROJECT_NAME,
  );
  if (existing?.id) return existing;
  logStage(`Provisioning SerenDB history project "${HISTORY_PROJECT_NAME}"`);
  return await createHistoryProject(token);
}

async function ensureNamedHistoryBranch(token, projectId) {
  const existing = (await listHistoryBranches(token, projectId)).find(
    (branch) => branch?.name === HISTORY_BRANCH_NAME,
  );
  if (existing?.id) return existing;
  logStage(`Provisioning SerenDB history branch "${HISTORY_BRANCH_NAME}"`);
  try {
    return await createHistoryBranch(token, projectId);
  } catch (error) {
    if (error instanceof SerenDbApiError && [400, 409].includes(error.status)) {
      const raced = (await listHistoryBranches(token, projectId)).find(
        (branch) => branch?.name === HISTORY_BRANCH_NAME,
      );
      if (raced?.id) return raced;
    }
    throw error;
  }
}

async function ensureHistoryDatabase(token, destination) {
  const existing = (await listHistoryDatabases(
    token,
    destination.projectId,
    destination.branchId,
  )).find((database) => database?.name === destination.databaseName);
  if (existing) return;
  logStage(`Provisioning SerenDB history database "${destination.databaseName}"`);
  try {
    await createHistoryDatabase(token, destination.projectId, destination.branchId);
  } catch (error) {
    if (error instanceof SerenDbApiError && [400, 409].includes(error.status)) {
      const raced = (await listHistoryDatabases(
        token,
        destination.projectId,
        destination.branchId,
      )).find((database) => database?.name === destination.databaseName);
      if (raced) return;
    }
    throw error;
  }
}

async function resolveNamedHistoryDestination(token) {
  const project = await ensureNamedHistoryProject(token);
  const branch = await ensureNamedHistoryBranch(token, project.id);
  const destination = {
    projectId: project.id,
    branchId: branch.id,
    databaseName: HISTORY_DATABASE_NAME,
  };
  await ensureHistoryDatabase(token, destination);
  await fetchHistoryConnectionString(token, destination);
  logStage(
    `Using self-provisioned history destination project=${destination.projectId} branch=${destination.branchId} database=${destination.databaseName}`,
  );
  return destination;
}

async function resolveHistoryDestination(token) {
  if ((HISTORY_PROJECT_ID && !HISTORY_BRANCH_ID) || (!HISTORY_PROJECT_ID && HISTORY_BRANCH_ID)) {
    throw new Error(
      "Set both SEREN_E2E_HISTORY_PROJECT_ID and SEREN_E2E_HISTORY_BRANCH_ID, or neither",
    );
  }
  if (HISTORY_PROJECT_ID && HISTORY_BRANCH_ID) {
    const destination = {
      projectId: HISTORY_PROJECT_ID,
      branchId: HISTORY_BRANCH_ID,
      databaseName: HISTORY_DATABASE_NAME,
    };
    try {
      await ensureHistoryDatabase(token, destination);
      await fetchHistoryConnectionString(token, destination);
      logStage(
        `Using explicit history destination project=${destination.projectId} branch=${destination.branchId} database=${destination.databaseName}`,
      );
      return destination;
    } catch (error) {
      if (error instanceof SerenDbApiError && error.status === 404) {
        console.warn(
          `[windows-e2e] explicit history destination returned HTTP 404; provisioning named e2e destination instead`,
        );
      } else {
        throw error;
      }
    }
  }
  return await resolveNamedHistoryDestination(token);
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

function validateProviderRuntimeConfig(config, label = "provider runtime config") {
  assert(
    config?.apiBaseUrl && config?.wsBaseUrl && config?.token,
    `${label} missing fields`,
  );
  return config;
}

async function resolveProviderRuntimeConfig(
  page,
  { timeoutMs = PROVIDER_CONFIG_TIMEOUT_MS, label = "provider runtime config" } = {},
) {
  return validateProviderRuntimeConfig(
    await withTimeout(tauriInvoke(page, "provider_runtime_get_config"), timeoutMs, label),
    label,
  );
}

async function fetchProviderRuntimeHealth(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_HEALTH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.apiBaseUrl}/__seren/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const health = await response.json();
    if (health?.ok !== true) {
      throw new Error(`health ok=${String(health?.ok)}`);
    }
    return health;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshProviderRuntimeConfig(page, previousConfig) {
  const nextConfig = await resolveProviderRuntimeConfig(page, {
    timeoutMs: PROVIDER_CONFIG_REFRESH_TIMEOUT_MS,
    label: "provider runtime config refresh",
  });
  if (
    nextConfig.apiBaseUrl !== previousConfig.apiBaseUrl ||
    nextConfig.wsBaseUrl !== previousConfig.wsBaseUrl ||
    nextConfig.token !== previousConfig.token
  ) {
    logStage(
      `Provider runtime config refreshed: api=${redactUrl(nextConfig.apiBaseUrl)} ws=${redactUrl(nextConfig.wsBaseUrl)}`,
    );
  }
  return nextConfig;
}

async function connectProviderRuntime(page, initialConfig) {
  let config = validateProviderRuntimeConfig(initialConfig);
  let failedHealthAttempts = 0;
  logStage(`Waiting for provider runtime health at ${config.apiBaseUrl}`);
  const health = await waitUntil(
    "provider runtime health",
    async () => {
      try {
        return await fetchProviderRuntimeHealth(config);
      } catch (error) {
        failedHealthAttempts += 1;
        if (failedHealthAttempts <= 3 || failedHealthAttempts % 10 === 0) {
          logStage(
            `Provider runtime health miss at ${redactUrl(config.apiBaseUrl)}; refreshing config (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        config = await refreshProviderRuntimeConfig(page, config);
        return null;
      }
    },
    { timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS },
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
const PROVIDER_CONFIG_REFRESH_TIMEOUT_MS = 5_000;
const PROVIDER_HEALTH_TIMEOUT_MS = 45_000;
const PROVIDER_HEALTH_REQUEST_TIMEOUT_MS = 2_000;
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
    `${journey} CLI could not be resolved, launched, or kept alive long enough ` +
      `to complete the Windows e2e prompt. Verify the scheduled-task user ` +
      `received the explicit e2e CLI prerequisites and agent credentials via ` +
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
      `${agentType} CLI resolution`,
    );
    logStage(`${agentType} provider CLI ready: ${String(resolved || "<unknown>")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw provisioningError(agentType, message);
  }
}

async function verifyAgentCliCompatibility(ws) {
  for (const agentType of CLI_COMPATIBILITY_AGENT_TYPES) {
    await ensureAgentCli(ws, agentType);
  }
  logStage(
    `all provider CLI resolution checks passed: ${CLI_COMPATIBILITY_AGENT_TYPES.join(", ")}`,
  );
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
  const config = await resolveProviderRuntimeConfig(page);
  logStage(
    `Provider runtime config resolved: api=${redactUrl(config.apiBaseUrl)} ws=${redactUrl(config.wsBaseUrl)}`,
  );
  const ws = await connectProviderRuntime(page, config);
  const buffer = createRuntimeBuffer(ws);
  try {
    await verifyAgentCliCompatibility(ws);
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

function isHistorySyncReadinessError(error) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return [
    "failed to connect to target database",
    "database not ready",
    "connection refused",
    "connection timed out",
    "connection string request failed: http 408",
    "connection string request failed: http 502",
    "connection string request failed: http 503",
    "connection string request failed: http 504",
    "returned http 408",
    "returned http 502",
    "returned http 503",
    "returned http 504",
    "server closed the connection",
    "could not connect",
  ].some((marker) => message.includes(marker));
}

async function runHistorySync(page, destination, label) {
  let lastError;
  for (let attempt = 1; attempt <= HISTORY_SYNC_READY_ATTEMPTS; attempt += 1) {
    try {
      const summary = await tauriInvoke(page, "history_sync_run_now", {
        projectId: destination.projectId,
        branchId: destination.branchId,
        databaseName: destination.databaseName,
      });
      assert(summary.conflicts === 0, `${label} history sync reported conflicts`);
      assert(summary.queued === 0, `${label} history sync left queued rows`);
      assert(
        summary.pushed > 0 || summary.pulled > 0 || summary.backfilled > 0,
        `${label} history sync moved no rows`,
      );
      console.log(`[windows-e2e] history sync ${label}: ${JSON.stringify(summary)}`);
      return summary;
    } catch (error) {
      lastError = error;
      if (!isHistorySyncReadinessError(error) || attempt === HISTORY_SYNC_READY_ATTEMPTS) {
        throw error;
      }
      console.warn(
        `[windows-e2e] history sync ${label} not ready (attempt ${attempt}/${HISTORY_SYNC_READY_ATTEMPTS}); retrying: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await sleep(HISTORY_SYNC_READY_DELAY_MS);
    }
  }
  throw lastError ?? new Error(`${label} history sync did not run`);
}

async function exerciseHistorySync(page, token) {
  const destination = await resolveHistoryDestination(token);
  await createConversationWithMessage(page, "before-wipe");
  await runHistorySync(page, destination, "initial");
  await tauriInvoke(page, "history_sync_wipe_remote", {
    projectId: destination.projectId,
    branchId: destination.branchId,
    databaseName: destination.databaseName,
    confirmation: destination.databaseName,
  });
  await createConversationWithMessage(page, "after-wipe");
  await runHistorySync(page, destination, "after-wipe-resync");
}

function powerShellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function playWindowsAudio() {
  const speechText = powerShellSingleQuoted(
    "Seren Windows end to end meeting capture test. This spoken system audio should be recorded and transcribed.",
  );
  const stimulusSeconds = Math.max(6, CAPTURE_SECONDS - 1);
  const command = [
    "$ErrorActionPreference = 'Continue'",
    `$deadline = (Get-Date).AddSeconds(${stimulusSeconds})`,
    "$playedSpeech = $false",
    "try {",
    "  $voice = New-Object -ComObject SAPI.SpVoice",
    "  $voice.Volume = 100",
    "  $voice.Rate = -1",
    "  while ((Get-Date) -lt $deadline) {",
    `    [void]$voice.Speak(${speechText}, 0)`,
    "    $playedSpeech = $true",
    "    Start-Sleep -Milliseconds 150",
    "  }",
    "} catch {",
    "  $playedSpeech = $false",
    "}",
    "if (-not $playedSpeech) {",
    "  while ((Get-Date) -lt $deadline) {",
    "    [Console]::Beep(880, 800)",
    "    Start-Sleep -Milliseconds 150",
    "    [Console]::Beep(660, 800)",
    "    Start-Sleep -Milliseconds 150",
    "  }",
    "}",
  ].join("; ");
  return spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    stdio: "ignore",
  });
}

async function injectMeetingCaptureAudio(page, meetingId) {
  await tauriInvoke(page, "e2e_inject_meeting_capture_audio", { meetingId });
  await sleep(500);
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
  await injectMeetingCaptureAudio(page, meeting.id);
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
    const token = await signIn(page);
    await exerciseAgentRuntime(page);
    await exerciseHistorySync(page, token);
    await validateGithubPat();
    await exerciseMeetingCapture(page);
    assertNoUnexpectedBrowserErrors(browserErrors);
    console.log("[windows-e2e] full Windows production e2e passed");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
