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

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  client?.close();
  happyLayer?.close();
  supervisorChannel?.close();
  input?.close();
  process.exitCode = exitCode;
  setImmediate(() => process.exit(exitCode));
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
  });
  await happyLayer.start();
} catch (error) {
  console.error(`happy-bridge: ${error instanceof Error ? error.message : "startup failed"}`);
  await shutdown();
}
