// ABOUTME: Composes the provider source and supervisor channel for the bridge.
// ABOUTME: It owns stdin lifecycle only; session mapping and RPC details live in modules.

import readline from "node:readline";
import {
  createProviderRuntimeClient,
  createProviderSource,
  validateBridgeConfig,
} from "./happy-bridge/provider-source.mjs";
import { createSupervisorChannel } from "./happy-bridge/supervisor-channel.mjs";

let client = null;
let input = null;
let supervisorChannel = null;
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

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  client?.close();
  supervisorChannel?.close();
  input?.close();
  process.exitCode = 0;
  setImmediate(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  const { configPromise, queuedResponses } = startInputReader();
  const config = await configPromise;
  supervisorChannel = createSupervisorChannel();
  for (const line of queuedResponses) supervisorChannel.handleLine(line);

  client = createProviderRuntimeClient(config);
  await client.connect();
  const source = createProviderSource({
    client,
    config,
    debugLog: (message) => console.error(`happy-bridge: ${message}`),
  });
  const sessions = await source.listSessions();
  console.error(`happy-bridge: config ok, ${sessions.length} sessions`);
} catch (error) {
  console.error(`happy-bridge: ${error instanceof Error ? error.message : "startup failed"}`);
  await shutdown();
}
