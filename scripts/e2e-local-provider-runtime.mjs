import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const ROOT = new URL("../", import.meta.url);
const HOST = "127.0.0.1";
const BROWSER_LOCAL_PORT = 4316;
const PROVIDER_RUNTIME_PORT = 4317;
const PROVIDER_RUNTIME_TOKEN = "e2e-provider-runtime-token";
const CWD = process.cwd();
const PROMPT_TEXT =
  process.env.SEREN_E2E_PROMPT ??
  "Reply with EXACTLY the text E2E_PONG and nothing else.";
const CANCEL_PROMPT_TEXT =
  process.env.SEREN_E2E_CANCEL_PROMPT ??
  "Think silently for a while before answering. Do not answer immediately.";
const REQUESTED_AGENTS = (process.env.SEREN_E2E_AGENTS ?? "codex,claude-code")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const REQUESTED_RUNTIMES = (
  process.env.SEREN_E2E_RUNTIMES ?? "browser-local,desktop-native"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function isAuthRequiredError(message) {
  const lower = String(message).toLowerCase();
  return (
    lower.includes("authentication required") ||
    lower.includes("auth required") ||
    lower.includes("login flow") ||
    lower.includes("not logged in") ||
    lower.includes("failed to authenticate") ||
    lower.includes("does not have access") ||
    lower.includes("please login") ||
    lower.includes("please sign in")
  );
}

function startProcess(command, args, label) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });

  return child;
}

async function fetchJson(url, attempts = 50) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function createNotificationBuffer(ws) {
  const notifications = [];
  const waiters = new Set();

  const onMessage = (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!message?.method) {
      return;
    }

    notifications.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  };

  ws.on("message", onMessage);

  return {
    close() {
      ws.off("message", onMessage);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("Notification buffer closed"));
      }
      waiters.clear();
    },
    mark() {
      return notifications.length;
    },
    slice(fromIndex = 0) {
      return notifications.slice(fromIndex);
    },
    waitFor(predicate, timeoutMs = 30_000, fromIndex = 0) {
      const existing = notifications.slice(fromIndex).find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timeout: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error("Timed out waiting for runtime notification"));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function rpcCall(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.id !== id) {
          return;
        }
        ws.off("message", onMessage);
        if (message.error) {
          reject(new Error(String(message.error.message ?? "Unknown RPC error")));
          return;
        }
        resolve(message.result);
      } catch (error) {
        ws.off("message", onMessage);
        reject(error);
      }
    };

    ws.on("message", onMessage);
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
    );
  });
}

async function connectRuntime(wsUrl, token) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await rpcCall(ws, "auth", { token });
  return ws;
}

function assistantTextSince(buffer, fromIndex, sessionId) {
  return buffer
    .slice(fromIndex)
    .filter(
      (entry) =>
        entry.method === "provider://message-chunk" &&
        entry.params?.sessionId === sessionId &&
        entry.params?.isThought !== true,
    )
    .map((entry) => String(entry.params?.text ?? ""))
    .join("");
}

async function waitForRemoteSessionListing(ws, agentType, sessionId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = await rpcCall(ws, "provider_list_remote_sessions", {
      agentType,
      cwd: CWD,
    });
    if (page?.sessions?.some?.((session) => session.sessionId === sessionId)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Remote session ${sessionId} was not listed for ${agentType}`);
}

async function runPrompt(ws, buffer, sessionId, promptText) {
  const marker = buffer.mark();
  await rpcCall(ws, "provider_prompt", {
    sessionId,
    prompt: promptText,
    context: null,
  });
  await buffer.waitFor(
    (message) =>
      message.method === "provider://prompt-complete" &&
      message.params?.sessionId === sessionId &&
      message.params?.historyReplay !== true,
    180_000,
    marker,
  );

  const text = assistantTextSince(buffer, marker, sessionId).trim();
  if (!text.includes("E2E_PONG")) {
    throw new Error(`Unexpected assistant text: ${text || "<empty>"}`);
  }
}

async function runCancel(ws, buffer, sessionId) {
  const marker = buffer.mark();
  const promptPromise = rpcCall(ws, "provider_prompt", {
    sessionId,
    prompt: CANCEL_PROMPT_TEXT,
    context: null,
  }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );

  await sleep(250);
  await rpcCall(ws, "provider_cancel", { sessionId });

  await buffer.waitFor(
    (message) =>
      message.params?.sessionId === sessionId &&
      ((message.method === "provider://error" &&
        /cancel/i.test(String(message.params?.error ?? ""))) ||
        (message.method === "provider://session-status" &&
          message.params?.status === "ready")),
    30_000,
    marker,
  );

  const outcome = await promptPromise;
  if (outcome.ok) {
    console.warn(
      `[runtime-e2e] Cancel prompt completed before interruption for ${sessionId}`,
    );
  }
}

async function runAgentFlow({ ws, buffer, runtimeLabel, agentType }) {
  const available = await rpcCall(ws, "provider_check_agent_available", {
    agentType,
  });
  if (!available) {
    console.log(`[runtime-e2e] ${runtimeLabel}/${agentType}: skipped (CLI unavailable)`);
    return { status: "skipped" };
  }

  const localSessionId = randomUUID();
  let session;
  try {
    session = await rpcCall(ws, "provider_spawn", {
      agentType,
      cwd: CWD,
      localSessionId,
      resumeAgentSessionId: null,
      sandboxMode: "workspace-write",
      apiKey: null,
      approvalPolicy: agentType === "codex" ? "on-failure" : "on-request",
      searchEnabled: false,
      networkEnabled: false,
      timeoutSecs: 60,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthRequiredError(message)) {
      console.log(`[runtime-e2e] ${runtimeLabel}/${agentType}: skipped (${message})`);
      return { status: "skipped" };
    }
    throw error;
  }

  try {
    await runPrompt(ws, buffer, session.id, PROMPT_TEXT);
    if (typeof session.agentSessionId === "string" && session.agentSessionId.length > 0) {
      await waitForRemoteSessionListing(ws, agentType, session.agentSessionId);
    }

    await runCancel(ws, buffer, session.id);

    await rpcCall(ws, "provider_terminate", { sessionId: session.id });

    const resumeLocalSessionId = randomUUID();
    const resumeMarker = buffer.mark();
    const resumed = await rpcCall(ws, "provider_spawn", {
      agentType,
      cwd: CWD,
      localSessionId: resumeLocalSessionId,
      resumeAgentSessionId: session.agentSessionId ?? null,
      sandboxMode: "workspace-write",
      apiKey: null,
      approvalPolicy: agentType === "codex" ? "on-failure" : "on-request",
      searchEnabled: false,
      networkEnabled: false,
      timeoutSecs: 60,
    });

    if (resumed.agentSessionId !== session.agentSessionId) {
      throw new Error(
        `Resumed remote session mismatch: ${resumed.agentSessionId ?? "<missing>"} !== ${session.agentSessionId ?? "<missing>"}`,
      );
    }

    await buffer.waitFor(
      (message) =>
        message.params?.sessionId === resumeLocalSessionId &&
        ((message.method === "provider://prompt-complete" &&
          message.params?.historyReplay === true) ||
          ((message.method === "provider://message-chunk" ||
            message.method === "provider://user-message") &&
            message.params?.replay === true)),
      30_000,
      resumeMarker,
    );

    if (agentType === "claude-code") {
      const forkedSessionId = await rpcCall(ws, "provider_native_fork_session", {
        sessionId: resumeLocalSessionId,
      });
      if (
        typeof forkedSessionId !== "string" ||
        forkedSessionId.length === 0 ||
        forkedSessionId === session.agentSessionId
      ) {
        throw new Error(`Unexpected Claude native fork result: ${forkedSessionId}`);
      }
    }

    await rpcCall(ws, "provider_terminate", { sessionId: resumeLocalSessionId });
    console.log(`[runtime-e2e] ${runtimeLabel}/${agentType}: passed`);
    return { status: "passed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthRequiredError(message)) {
      console.log(`[runtime-e2e] ${runtimeLabel}/${agentType}: skipped (${message})`);
      return { status: "skipped" };
    }
    throw error;
  } finally {
    await rpcCall(ws, "provider_terminate", { sessionId: session.id }).catch(() => {});
  }
}

async function runRuntime(runtime) {
  const healthUrl =
    runtime === "browser-local"
      ? `http://${HOST}:${BROWSER_LOCAL_PORT}/__seren/health`
      : `http://${HOST}:${PROVIDER_RUNTIME_PORT}/__seren/health`;
  const wsUrl =
    runtime === "browser-local"
      ? `ws://${HOST}:${BROWSER_LOCAL_PORT}`
      : `ws://${HOST}:${PROVIDER_RUNTIME_PORT}`;
  const health = await fetchJson(healthUrl);
  const token = runtime === "browser-local" ? health.token : PROVIDER_RUNTIME_TOKEN;
  const ws = await connectRuntime(wsUrl, token);
  const buffer = createNotificationBuffer(ws);

  try {
    const results = [];
    for (const agentType of REQUESTED_AGENTS) {
      results.push(
        await runAgentFlow({
          ws,
          buffer,
          runtimeLabel: runtime,
          agentType,
        }),
      );
    }
    return results;
  } finally {
    buffer.close();
    ws.close();
  }
}

async function main() {
  const browserLocal = startProcess(
    process.execPath,
    [
      "bin/seren-desktop.mjs",
      "--host",
      HOST,
      "--port",
      String(BROWSER_LOCAL_PORT),
      "--project",
      CWD,
      "--no-browser",
    ],
    "browser-local",
  );
  const providerRuntime = startProcess(
    process.execPath,
    [
      "bin/provider-runtime.mjs",
      "--host",
      HOST,
      "--port",
      String(PROVIDER_RUNTIME_PORT),
      "--token",
      PROVIDER_RUNTIME_TOKEN,
    ],
    "provider-runtime",
  );

  const cleanup = () => {
    browserLocal.kill("SIGTERM");
    providerRuntime.kill("SIGTERM");
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    const results = [];
    for (const runtime of REQUESTED_RUNTIMES) {
      results.push(...(await runRuntime(runtime)));
    }

    const passed = results.filter((result) => result.status === "passed").length;
    const skipped = results.filter((result) => result.status === "skipped").length;
    console.log(
      `[runtime-e2e] complete: ${passed} passed, ${skipped} skipped across ${REQUESTED_RUNTIMES.length} runtime(s)`,
    );
  } finally {
    cleanup();
    await Promise.allSettled([
      new Promise((resolve) => browserLocal.once("exit", resolve)),
      new Promise((resolve) => providerRuntime.once("exit", resolve)),
    ]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
