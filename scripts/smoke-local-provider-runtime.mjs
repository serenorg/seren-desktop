import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const ROOT = new URL("../", import.meta.url);
const HOST = "127.0.0.1";
const BROWSER_LOCAL_PORT = 4316;
const PROVIDER_RUNTIME_PORT = 4317;
const PROVIDER_RUNTIME_TOKEN = "smoke-provider-runtime-token";

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

async function assertMethodExists(ws, method, params, expectedMessagePart) {
  try {
    await rpcCall(ws, method, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Method not found")) {
      throw new Error(`${method} is not registered`);
    }
    if (expectedMessagePart && !message.includes(expectedMessagePart)) {
      throw new Error(`${method} returned unexpected error: ${message}`);
    }
  }
}

async function smokeRuntime({ label, wsUrl, token }) {
  const ws = await connectRuntime(wsUrl, token);
  try {
    const agents = await rpcCall(ws, "provider_get_available_agents");
    if (!Array.isArray(agents)) {
      throw new Error(`${label}: provider_get_available_agents did not return an array`);
    }

    const sessions = await rpcCall(ws, "provider_list_sessions");
    if (!Array.isArray(sessions)) {
      throw new Error(`${label}: provider_list_sessions did not return an array`);
    }

    const codexAvailable = await rpcCall(ws, "provider_check_agent_available", {
      agentType: "codex",
    });
    if (typeof codexAvailable !== "boolean") {
      throw new Error(`${label}: provider_check_agent_available did not return a boolean`);
    }

    await assertMethodExists(
      ws,
      "provider_set_session_model",
      { sessionId: "missing-session", modelId: "gpt-5" },
      "Session not found",
    );
    await assertMethodExists(
      ws,
      "provider_update_session_config_option",
      {
        sessionId: "missing-session",
        configId: "reasoning_effort",
        valueId: "high",
      },
      "Session not found",
    );
    await assertMethodExists(
      ws,
      "provider_fork_session",
      { sessionId: "missing-session" },
      null,
    );
  } finally {
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
      process.cwd(),
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
    const browserHealth = await fetchJson(
      `http://${HOST}:${BROWSER_LOCAL_PORT}/__seren/health`,
    );
    const providerHealth = await fetchJson(
      `http://${HOST}:${PROVIDER_RUNTIME_PORT}/__seren/health`,
    );

    await smokeRuntime({
      label: "browser-local",
      wsUrl: `ws://${HOST}:${BROWSER_LOCAL_PORT}`,
      token: browserHealth.token,
    });
    await smokeRuntime({
      label: "provider-runtime",
      wsUrl: `ws://${HOST}:${PROVIDER_RUNTIME_PORT}`,
      token: PROVIDER_RUNTIME_TOKEN,
    });

    if (providerHealth.mode !== "desktop-native") {
      throw new Error(`Unexpected provider-runtime mode: ${providerHealth.mode}`);
    }

    console.log("Local provider runtime smoke passed.");
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
