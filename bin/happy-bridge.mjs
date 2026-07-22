// ABOUTME: Composes the provider source and supervisor channel for the bridge.
// ABOUTME: It owns stdin lifecycle only; session mapping and RPC details live in modules.

import readline from "node:readline";
import {
  createProviderRuntimeClient,
  createProviderSource,
  validateBridgeConfig,
} from "./happy-bridge/provider-source.mjs";
import { createHappyLayer } from "./happy-bridge/happy-layer.mjs";
import { createSupervisorChannel } from "./happy-bridge/supervisor-channel.mjs";

let client = null;
let input = null;
let supervisorChannel = null;
let happyLayer = null;
let shuttingDown = false;

function startInputReader() {
  input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let configReceived = false;
  let resolveConfig;
  let rejectConfig;
  const queuedResponses = [];
  const configPromise = new Promise((resolve, reject) => {
    resolveConfig = resolve;
    rejectConfig = reject;
  });

  input.on("line", (line) => {
    if (!configReceived) {
      if (!line.trim()) return;
      configReceived = true;
      try {
        resolveConfig(validateBridgeConfig(JSON.parse(line)));
      } catch (error) {
        rejectConfig(error);
      }
      return;
    }

    if (supervisorChannel) {
      supervisorChannel.handleLine(line);
    } else {
      queuedResponses.push(line);
    }
  });
  input.once("close", () => {
    if (!configReceived) rejectConfig(new Error("stdin closed before config was received"));
  });

  return { configPromise, queuedResponses };
}

// Caps the wait for the closes below so a socket that never completes its
// handshake still exits well inside the supervisor's STOP_GRACE_PERIOD.
const CLOSE_TIMEOUT_MS = 4000;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Awaited: exiting while these are still tearing down aborts the process on
  // Windows with an assertion in uv_async_send. The loop cannot be left to
  // drain on its own instead, because a child's piped stdout and stderr keep
  // it alive indefinitely.
  const closeBridgeComponents = (async () => {
    // Keep the provider RPC socket open until Happy has unwound any in-flight
    // remote spawn; that cleanup may still need provider terminate/list calls.
    await Promise.allSettled([happyLayer?.close()]);
    await Promise.allSettled([client?.close()]);
  })();
  await Promise.race([
    closeBridgeComponents,
    new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ]);
  supervisorChannel?.close();
  input?.close();
  process.exitCode = exitCode;
  process.exit(exitCode);
}

// Signal handlers receive the signal name as their first argument, which is not
// a valid exit code; pass an explicit one.
process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));

try {
  const { configPromise, queuedResponses } = startInputReader();
  const config = await configPromise;
  supervisorChannel = createSupervisorChannel();
  for (const line of queuedResponses) supervisorChannel.handleLine(line);

  client = createProviderRuntimeClient(config, {
    onUnexpectedDisconnect: (reason) => {
      supervisorChannel?.notify("status_report", {
        state: "error",
        detail: `provider runtime connection lost (${reason})`,
      });
      void shutdown(1);
    },
  });
  await client.connect();
  const source = createProviderSource({
    client,
    config,
    debugLog: (message) => console.error(`happy-bridge: ${message}`),
  });
  const sessions = await source.listSessions();
  console.error(`happy-bridge: config ok, ${sessions.length} sessions`);
  happyLayer = createHappyLayer({
    config,
    supervisorChannel,
    source,
    debugLog: (message) => console.error(`happy-bridge: ${message}`),
    onShutdownRequest: () => shutdown(0),
  });
  await happyLayer.start();
} catch (error) {
  console.error(`happy-bridge: ${error instanceof Error ? error.message : "startup failed"}`);
  await shutdown();
}
