// ABOUTME: Connects a future Happy layer to Seren Desktop's provider runtime.
// ABOUTME: Reads one stdin config, logs only shapes, and owns clean shutdown.

import readline from "node:readline";
import WebSocket from "ws";

const RPC_TIMEOUT_MS = 30_000;

function fail(message) {
  throw new Error(message);
}

function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("config must be an object");
  }

  const providerRuntime = value.providerRuntime;
  if (!providerRuntime || typeof providerRuntime !== "object") {
    fail("config.providerRuntime is required");
  }
  if (typeof providerRuntime.host !== "string" || providerRuntime.host.length === 0) {
    fail("config.providerRuntime.host is required");
  }
  if (!Number.isInteger(providerRuntime.port) || providerRuntime.port < 1 || providerRuntime.port > 65535) {
    fail("config.providerRuntime.port must be a valid TCP port");
  }
  if (typeof providerRuntime.token !== "string" || providerRuntime.token.length === 0) {
    fail("config.providerRuntime.token is required");
  }
  if (typeof value.relayUrl !== "string" || value.relayUrl.length === 0) {
    fail("config.relayUrl is required");
  }
  if (typeof value.machineName !== "string" || value.machineName.length === 0) {
    fail("config.machineName is required");
  }
  if (value.machineIdentity !== null && (typeof value.machineIdentity !== "object" || Array.isArray(value.machineIdentity))) {
    fail("config.machineIdentity must be an object or null");
  }

  return value;
}

async function readConfig() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      return validateConfig(JSON.parse(line));
    }
  } finally {
    // Do not close stdin: Phase 2 will use the remaining stream for bookkeeping RPC.
    input.pause();
  }
  fail("stdin closed before config was received");
}

class ProviderRuntimeClient {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    const { host, port, token } = this.config.providerRuntime;
    this.socket = new WebSocket(`ws://${host}:${port}`);
    this.socket.on("message", (raw) => this.handleMessage(raw));
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () => reject(new Error("provider runtime connection failed")));
    });
    await this.call("auth", { token });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error("provider runtime RPC failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("provider runtime socket is not open"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("provider runtime RPC timed out"));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("provider runtime client closed"));
    }
    this.pending.clear();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "bridge shutdown");
    }
    this.socket = null;
  }
}

let client = null;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  client?.close();
  process.exitCode = 0;
  setImmediate(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  const config = await readConfig();
  client = new ProviderRuntimeClient(config);
  await client.connect();
  const result = await client.call("provider_list_sessions");
  const sessions = Array.isArray(result) ? result : result?.sessions;
  const sessionCount = Array.isArray(sessions) ? sessions.length : 0;
  console.error(`happy-bridge: config ok, ${sessionCount} sessions`);
} catch (error) {
  console.error(`happy-bridge: ${error instanceof Error ? error.message : "startup failed"}`);
  await shutdown();
}
