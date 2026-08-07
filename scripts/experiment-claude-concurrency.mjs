// ABOUTME: Measures concurrent Claude Code session behavior in the embedded provider runtime.
// ABOUTME: Uses real provider RPCs and records session identity, readiness, prompts, and failures.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const HOST = "127.0.0.1";
const PRIMARY_PORT = 4317;
const SECONDARY_PORT = 4318;
const RUNTIME_TOKEN = "claude-concurrency-experiment-token";
const CWD = process.cwd();
const AGENT_TYPE = "claude-code";
const PROMPT_TIMEOUT_MS = 180_000;
const INIT_ERROR_TEXT = [
  "timed out waiting for claude control request initialize",
  "server shut down unexpectedly",
  "signal: 9",
  "sigkill",
];

function ensureSandboxSpecBin() {
  if (typeof process.env.SEREN_SANDBOX_SPEC_BIN === "string" &&
      process.env.SEREN_SANDBOX_SPEC_BIN.trim().length > 0) {
    return;
  }

  const names = process.platform === "win32"
    ? ["Seren.exe", "seren-desktop.exe"]
    : ["Seren", "seren-desktop"];
  const candidates = [];
  for (const profile of ["release", "debug"]) {
    for (const name of names) {
      candidates.push(join(ROOT_PATH, "src-tauri", "target", profile, name));
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "The embedded app binary is required for bounded Claude Code sessions. " +
        "Build it with cargo build --manifest-path src-tauri/Cargo.toml.",
    );
  }
  process.env.SEREN_SANDBOX_SPEC_BIN = found;
  console.log("[concurrency] sandbox spec binary: " + found);
}

function isAuthRequiredError(message) {
  const lower = String(message).toLowerCase();
  return lower.includes("authentication required") ||
    lower.includes("auth required") ||
    lower.includes("login flow") ||
    lower.includes("not logged in") ||
    lower.includes("failed to authenticate") ||
    lower.includes("please login") ||
    lower.includes("please sign in");
}

function isRetryableClaudeInitError(message) {
  const lower = String(message).toLowerCase();
  return INIT_ERROR_TEXT.some((fragment) => lower.includes(fragment));
}

async function fetchJson(url, attempts = 80) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw lastError ?? new Error("Timed out waiting for " + url);
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
    if (!message?.method) return;
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
      if (existing) return Promise.resolve(existing);
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

let nextRpcId = 1;
function rpcCall(ws, method, params = {}) {
  const id = nextRpcId++;
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.id !== id) return;
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
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function connectRuntime(port) {
  const ws = new WebSocket("ws://" + HOST + ":" + port);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await rpcCall(ws, "auth", { token: RUNTIME_TOKEN });
  return ws;
}

function startRuntimeProcess(port, label) {
  const child = spawn(
    process.execPath,
    [
      "bin/provider-runtime.mjs",
      "--host",
      HOST,
      "--port",
      String(port),
    ],
    {
      cwd: ROOT_PATH,
      env: {
        ...process.env,
        SEREN_PROVIDER_RUNTIME_TOKEN: RUNTIME_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    process.stdout.write("[" + label + "] " + chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write("[" + label + "] " + chunk);
  });
  return child;
}

async function startRuntime(port, label) {
  const child = startRuntimeProcess(port, label);
  try {
    await fetchJson("http://" + HOST + ":" + port + "/__seren/health");
    const ws = await connectRuntime(port);
    return {
      child,
      port,
      ws,
      buffer: createNotificationBuffer(ws),
      sessions: new Map(),
    };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    child.once("exit", finish);
  });
}

function spawnParams(localSessionId) {
  return {
    agentType: AGENT_TYPE,
    cwd: CWD,
    localSessionId,
    resumeAgentSessionId: null,
    sandboxMode: process.env.SEREN_CONCURRENCY_SANDBOX_MODE ?? "full-access",
    apiKey: null,
    approvalPolicy: "on-request",
    searchEnabled: false,
    networkEnabled: true,
    timeoutSecs: 60,
  };
}

async function checkClaude(runtime) {
  const available = await rpcCall(runtime.ws, "provider_check_agent_available", {
    agentType: AGENT_TYPE,
  });
  if (available !== true) {
    throw new Error("provider_check_agent_available returned false for claude-code");
  }
  try {
    const authenticated = await rpcCall(
      runtime.ws,
      "provider_check_agent_authenticated",
      { agentType: AGENT_TYPE },
    );
    if (authenticated === false) {
      throw new Error("Claude Code authentication required by provider runtime");
    }
  } catch (error) {
    if (isAuthRequiredError(error.message)) throw error;
    if (!String(error.message).toLowerCase().includes("method not found")) {
      console.log("[concurrency] authentication probe detail: " + error.message);
    }
  }
}

async function spawnMeasured(runtime, label, requestedSessionId = randomUUID()) {
  const startedAt = performance.now();
  const localSessionId = requestedSessionId;
  const marker = runtime.buffer.mark();
  try {
    const result = await rpcCall(
      runtime.ws,
      "provider_spawn",
      spawnParams(localSessionId),
    );
    const readyEvent = await runtime.buffer
      .waitFor(
        (message) =>
          message.method === "provider://session-status" &&
          message.params?.sessionId === result.id &&
          message.params?.status === "ready",
        1_000,
        marker,
      )
      .catch(() => null);
    const record = {
      label,
      runtime: runtime.port,
      status: "ready",
      sessionId: result.id,
      agentSessionId: result.agentSessionId ?? null,
      spawnToReadyMs: Math.round(performance.now() - startedAt),
      readyAtMs: performance.now(),
      cliVersion: readyEvent?.params?.agentInfo?.version ?? null,
      error: null,
      retryableInitError: false,
    };
    runtime.sessions.set(record.sessionId, record);
    console.log(
      "[concurrency] " + label +
        " ready sessionId=" + record.sessionId +
        " agentSessionId=" + (record.agentSessionId ?? "<missing>") +
        " spawnToReadyMs=" + record.spawnToReadyMs,
    );
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = {
      label,
      runtime: runtime.port,
      status: "error",
      sessionId: null,
      agentSessionId: null,
      spawnToReadyMs: Math.round(performance.now() - startedAt),
      readyAtMs: null,
      cliVersion: null,
      error: message,
      retryableInitError: isRetryableClaudeInitError(message),
    };
    console.log(
      "[concurrency] " + label +
        " error spawnToReadyMs=" + record.spawnToReadyMs +
        " retryableInitError=" + record.retryableInitError +
        " error=" + message,
    );
    if (isAuthRequiredError(message)) throw error;
    return record;
  }
}

async function promptMeasured(runtime, session, letter) {
  const marker = runtime.buffer.mark();
  const startedAt = performance.now();
  const expected = "PONG_" + letter;
  try {
    await rpcCall(runtime.ws, "provider_prompt", {
      sessionId: session.sessionId,
      prompt: "Reply with EXACTLY the text " + expected,
      context: null,
    });
    await runtime.buffer.waitFor(
      (message) =>
        message.method === "provider://prompt-complete" &&
        message.params?.sessionId === session.sessionId &&
        message.params?.historyReplay !== true,
      1_000,
      marker,
    ).catch(() => null);
    const text = runtime.buffer
      .slice(marker)
      .filter(
        (message) =>
          message.method === "provider://message-chunk" &&
          message.params?.sessionId === session.sessionId &&
          message.params?.isThought !== true,
      )
      .map((message) => String(message.params?.text ?? ""))
      .join("")
      .trim();
    if (!text.includes(expected)) {
      throw new Error("Unexpected assistant text: " + (text || "<empty>"));
    }
    const record = {
      label: session.label,
      status: "passed",
      promptRoundTripMs: Math.round(performance.now() - startedAt),
      text,
      error: null,
    };
    session.prompt = record;
    console.log(
      "[concurrency] " + session.label +
        " promptRoundTripMs=" + record.promptRoundTripMs +
        " text=" + JSON.stringify(text),
    );
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = {
      label: session.label,
      status: "error",
      promptRoundTripMs: Math.round(performance.now() - startedAt),
      text: null,
      error: message,
    };
    session.prompt = record;
    console.log(
      "[concurrency] " + session.label +
        " prompt error promptRoundTripMs=" + record.promptRoundTripMs +
        " error=" + message,
    );
    if (isAuthRequiredError(message)) throw error;
    return record;
  }
}

async function terminateRuntimeSessions(runtime) {
  for (const session of runtime.sessions.values()) {
    await rpcCall(runtime.ws, "provider_terminate", {
      sessionId: session.sessionId,
    }).catch(() => {});
  }
  runtime.sessions.clear();
}

async function closeRuntime(runtime) {
  if (!runtime) return;
  await terminateRuntimeSessions(runtime);
  runtime.buffer.close();
  runtime.ws.close();
  runtime.child.kill("SIGTERM");
  await waitForExit(runtime.child);
}

async function runQueueProof() {
  process.env.SEREN_CLAUDE_SESSION_LIMIT = "1";
  const runtime = await startRuntime(PRIMARY_PORT, "queue-runtime");
  try {
    await checkClaude(runtime);
    const sessionA = await spawnMeasured(runtime, "A-queue-proof");
    if (sessionA.status !== "ready") {
      throw new Error("Queue proof session A did not reach ready: " + sessionA.error);
    }

    const queuedSessionId = randomUUID();
    const marker = runtime.buffer.mark();
    let bSettled = false;
    const bPromise = spawnMeasured(runtime, "B-queue-proof", queuedSessionId)
      .finally(() => {
        bSettled = true;
      });
    const queuedEvent = await runtime.buffer.waitFor(
      (message) =>
        message.method === "provider://session-status" &&
        message.params?.sessionId === queuedSessionId &&
        message.params?.status === "queued",
      30_000,
      marker,
    );
    const queuedAtMs = performance.now();
    await sleep(250);
    const activeTerminationsBeforeRelease = runtime.buffer
      .slice(marker)
      .filter(
        (message) =>
          message.method === "provider://session-status" &&
          message.params?.sessionId === sessionA.sessionId &&
          message.params?.status === "terminated",
      ).length;
    const bSettledBeforeRelease = bSettled;
    console.log(
      "[queue-proof] queued sessionId=" + queuedSessionId +
        " position=" + (queuedEvent.params?.queuePosition ?? "<missing>") +
        " activeTerminationsBeforeRelease=" + activeTerminationsBeforeRelease +
        " promiseUnresolvedBeforeRelease=" + (!bSettledBeforeRelease),
    );

    await rpcCall(runtime.ws, "provider_terminate", {
      sessionId: sessionA.sessionId,
    });
    await runtime.buffer.waitFor(
      (message) =>
        message.method === "provider://session-status" &&
        message.params?.sessionId === sessionA.sessionId &&
        message.params?.status === "terminated",
      30_000,
      marker,
    );
    const firstTerminatedAtMs = performance.now();
    const sessionB = await bPromise;
    const reachedReadyAfterTermination =
      sessionB.status === "ready" &&
      sessionB.readyAtMs >= firstTerminatedAtMs;
    const queuedDurationMs = Math.round(
      (sessionB.readyAtMs ?? performance.now()) - queuedAtMs,
    );
    console.log(
      "[queue-proof] sessionId=" + queuedSessionId +
        " queuedDurationMs=" + queuedDurationMs +
        " reachedReadyAfterFirstTermination=" + reachedReadyAfterTermination,
    );
    if (
      activeTerminationsBeforeRelease !== 0 ||
      bSettledBeforeRelease ||
      !reachedReadyAfterTermination
    ) {
      throw new Error("Queue proof invariants failed");
    }
    console.log("[queue-proof] passed");
  } finally {
    await closeRuntime(runtime);
  }
}

function cliVersionFallback() {
  try {
    return execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Spawns `target` Claude sessions against one runtime, then prompts every live
 * session concurrently. Reports where readiness or prompting actually breaks
 * down, so the admission cap can be set from measurement instead of a guess.
 *
 * Run with the gate raised out of the way, e.g.
 *   SEREN_CLAUDE_SESSION_LIMIT=12 node scripts/experiment-claude-concurrency.mjs --probe 8
 */
async function runConcurrencyProbe(target) {
  const runtimes = [];
  try {
    const primary = await startRuntime(PRIMARY_PORT, "runtime-1");
    runtimes.push(primary);
    await checkClaude(primary);

    const live = [];
    const spawns = [];
    for (let i = 1; i <= target; i += 1) {
      const label = "S" + i;
      const session = await spawnMeasured(primary, label);
      spawns.push({
        label,
        status: session.status,
        spawnToReadyMs: session.spawnToReadyMs ?? null,
        error: session.error ?? null,
      });
      if (session.status !== "ready") {
        console.log("[probe] " + label + " FAILED: " + session.error);
        break;
      }
      live.push(session);
      console.log(
        "[probe] " +
          label +
          " ready spawnToReadyMs=" +
          session.spawnToReadyMs +
          " liveSessions=" +
          live.length,
      );
    }

    const promptStart = process.hrtime.bigint();
    await Promise.all(
      live.map((session, idx) => promptMeasured(primary, session, "S" + (idx + 1))),
    );
    const wallMs = Number(process.hrtime.bigint() - promptStart) / 1e6;

    console.log(
      "PROBE_JSON: " +
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          targetSessions: target,
          liveSessions: live.length,
          concurrentPromptWallMs: Math.round(wallMs),
          spawns,
          prompts: live.map((session, idx) => ({
            label: "S" + (idx + 1),
            status: session.prompt?.status ?? "unknown",
            promptRoundTripMs: session.prompt?.promptRoundTripMs ?? null,
            error: session.prompt?.error ?? null,
          })),
        }),
    );
  } finally {
    await Promise.all(runtimes.map((runtime) => closeRuntime(runtime)));
  }
}

async function main() {
  ensureSandboxSpecBin();
  if (process.argv.includes("--queue-proof")) {
    try {
      await runQueueProof();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[queue-proof] BLOCKER: " + message);
      process.exitCode = isAuthRequiredError(message) ? 2 : 1;
    }
    return;
  }
  // `--probe N` measures how many concurrent Claude sessions the machine and
  // CLI actually tolerate, which is what the admission cap should be derived
  // from. The A/B/C flow below only ever proves 3 and cannot justify a higher
  // number. #3727.
  const probeIdx = process.argv.indexOf("--probe");
  if (probeIdx !== -1) {
    const target = Number(process.argv[probeIdx + 1] ?? "8");
    try {
      await runConcurrencyProbe(target);
    } catch (error) {
      console.error(
        "[probe] BLOCKER: " +
          (error instanceof Error ? error.message : String(error)),
      );
      process.exitCode = 1;
    }
    return;
  }

  const runtimes = [];
  let outcome = "serialize";
  let blocker = null;
  try {
    const primary = await startRuntime(PRIMARY_PORT, "runtime-1");
    runtimes.push(primary);
    await checkClaude(primary);

    const sessionA = await spawnMeasured(primary, "A");
    if (sessionA.status !== "ready") {
      throw new Error("Session A did not reach ready: " + sessionA.error);
    }

    const sessionB = await spawnMeasured(primary, "B");
    if (sessionB.status === "ready") {
      await Promise.all([
        promptMeasured(primary, sessionA, "A"),
        promptMeasured(primary, sessionB, "B"),
      ]);

      const sessionC = await spawnMeasured(primary, "C");
      if (sessionC.status === "ready") {
        await promptMeasured(primary, sessionC, "C");
        outcome = "coexist";
      } else {
        const secondary = await startRuntime(SECONDARY_PORT, "runtime-2");
        runtimes.push(secondary);
        const crossProcessC = await spawnMeasured(secondary, "C-cross-process");
        outcome = crossProcessC.status === "ready" ? "process-pool" : "serialize";
      }
    } else {
      const secondary = await startRuntime(SECONDARY_PORT, "runtime-2");
      runtimes.push(secondary);
      await checkClaude(secondary);
      const crossProcessB = await spawnMeasured(secondary, "B-cross-process");
      if (crossProcessB.status === "ready") {
        await promptMeasured(secondary, crossProcessB, "B");
        outcome = "process-pool";
      }
    }

    const allSessions = runtimes.flatMap((runtime) => [...runtime.sessions.values()]);
    const cliVersion =
      allSessions
        .map((session) => session.cliVersion)
        .find((version) => version && version !== "unknown") ??
      cliVersionFallback();
    console.log("OUTCOME: " + outcome);
    console.log(
      "RESULT_JSON: " +
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          cwd: CWD,
          cliVersion,
          sessions: allSessions,
          outcome,
        }),
    );
  } catch (error) {
    blocker = error instanceof Error ? error.message : String(error);
    console.error("[concurrency] BLOCKER: " + blocker);
    if (isAuthRequiredError(blocker)) {
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(runtimes.map((runtime) => closeRuntime(runtime)));
  }

  if (blocker) {
    console.log("OUTCOME: serialize");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
