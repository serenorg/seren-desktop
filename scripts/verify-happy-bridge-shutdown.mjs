// ABOUTME: Verifies the Happy bridge exits on a supervisor shutdown notification.
// ABOUTME: Exists because Windows has no SIGTERM, so this path is platform-specific.

// Runs the REAL bridge entrypoint under the REAL platform Node, driven the same
// way Rust drives it: config on stdin, then a newline-delimited JSON-RPC
// notification. The provider runtime is a real local WebSocket server rather
// than a stub of the layer under test — what is being verified is whether a
// Node child on this OS receives the notification over a stdio pipe and exits
// promptly, which is exactly what `terminate_child` depends on.
//
// Before #3031 the SIGTERM in `terminate_child` was `#[cfg(unix)]`, so on
// Windows nothing ever told the child to exit: `child.wait()` burned the full
// 5s grace period and the process was then hard-killed, skipping the relay
// disconnect. A pass here means the graceful path works on this platform.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const STOP_GRACE_PERIOD_MS = 5000; // mirrors STOP_GRACE_PERIOD in happy_bridge.rs
const STARTUP_TIMEOUT_MS = 30_000;
const TOKEN = "verify-shutdown-token";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeEntry = path.join(repoRoot, "bin", "happy-bridge.mjs");

function log(message) {
  process.stdout.write(`[verify-shutdown] ${message}\n`);
}

// A relay that accepts the pairing request but never authorizes it, holding the
// bridge in the "waiting to be paired" state — which is precisely when a user
// toggles remote access back off. An unreachable relay is NOT usable here: the
// entrypoint catches the startup failure and calls `shutdown()`, which exits 0
// on its own and makes this check pass whether or not the fix is present.
async function startRelay() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "requested" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  log(`relay listening on 127.0.0.1:${port}`);
  return { server, port };
}

// Stands in for the provider runtime so the bridge can finish startup and
// register its supervisor listener. It answers the calls made during startup
// and nothing else.
async function startProviderRuntime() {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      let request;
      try {
        request = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (request?.id === undefined || request?.id === null) return;
      const result = request.method === "provider_list_sessions" ? { sessions: [] } : {};
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  log(`provider runtime listening on 127.0.0.1:${port}`);
  return { server, wss, port };
}

async function main() {
  const runtime = await startProviderRuntime();
  const relay = await startRelay();

  const child = spawn(process.execPath, [bridgeEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: repoRoot,
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let pairingPayloadSeen = false;
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      if (line.includes("pairing_payload")) pairingPayloadSeen = true;
      log(`bridge -> supervisor: ${line.trim()}`);
    }
  });

  const exited = once(child, "exit");

  // The shutdown listener is registered at the top of `start()`, before
  // registration completes, and the relay above never authorizes — so the bridge
  // sits alive in the "waiting to be paired" state while we signal it.
  const config = {
    providerRuntime: { host: "127.0.0.1", port: runtime.port, token: TOKEN },
    relayUrl: `http://127.0.0.1:${relay.port}`,
    machineIdentity: null,
    machineName: "verify-shutdown",
  };
  child.stdin.write(`${JSON.stringify(config)}\n`);
  log("config written");

  // Wait for the bridge to report it is past config parsing and connected to
  // the provider runtime, so the shutdown notification lands on a started
  // bridge rather than one still booting.
  const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!pairingPayloadSeen && Date.now() < startupDeadline) {
    if (child.exitCode !== null) {
      throw new Error(`bridge exited during startup (code ${child.exitCode})\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!pairingPayloadSeen) {
    child.kill();
    throw new Error(`bridge never reached the pairing wait in ${STARTUP_TIMEOUT_MS}ms\n${stderr}`);
  }
  log("bridge is up and waiting to be paired");

  // Guard against the false green this check originally produced: if the bridge
  // is already gone, nothing below is measuring the shutdown path.
  if (child.exitCode !== null) {
    throw new Error(`bridge exited before the notification was sent (code ${child.exitCode})\n${stderr}`);
  }

  const sentAt = Date.now();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "shutdown" })}\n`);
  log("shutdown notification written");

  const timer = setTimeout(() => {
    log(`FAIL: still running after ${STOP_GRACE_PERIOD_MS}ms — this is the bug`);
    child.kill();
  }, STOP_GRACE_PERIOD_MS);

  const [code, signal] = await exited;
  clearTimeout(timer);
  const elapsed = Date.now() - sentAt;

  runtime.wss.close();
  runtime.server.close();
  relay.server.close();

  log(`exited after ${elapsed}ms (code=${code} signal=${signal})`);

  if (signal || code === null) {
    log("FAIL: bridge had to be killed rather than exiting on its own");
    process.exitCode = 1;
    return;
  }
  if (elapsed >= STOP_GRACE_PERIOD_MS) {
    log(`FAIL: exit took ${elapsed}ms, at or beyond the ${STOP_GRACE_PERIOD_MS}ms grace period`);
    process.exitCode = 1;
    return;
  }
  if (code !== 0) {
    log(`FAIL: expected a clean exit code, got ${code}`);
    process.exitCode = 1;
    return;
  }
  log(`PASS: graceful shutdown on ${process.platform} in ${elapsed}ms`);
}

main().catch((error) => {
  log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
