// ABOUTME: Live walkthrough for #3727 against a real provider runtime and real Claude CLI.
// ABOUTME: Reproduces slot exhaustion, then proves capacity accounting and reclaim.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.WALKTHROUGH_PORT ?? "4319");
const TOKEN = "walkthrough-3727-token";
const CWD = process.cwd();

function resolveSandboxSpecBin() {
  if (process.env.SEREN_SANDBOX_SPEC_BIN) return process.env.SEREN_SANDBOX_SPEC_BIN;
  for (const profile of ["release", "debug"]) {
    const candidate = join(ROOT_PATH, "src-tauri", "target", profile, "Seren");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Build the app binary first (cargo build --manifest-path src-tauri/Cargo.toml)");
}

let nextId = 1;
const pending = new Map();
const notifications = [];

function rpc(ws, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`RPC ${method} timed out`));
    }, 180_000).unref();
  });
}

async function main() {
  const limit = process.env.SEREN_CLAUDE_SESSION_LIMIT ?? "2";
  const child = spawn(
    process.execPath,
    [join(ROOT_PATH, "bin", "provider-runtime.mjs"), "--host", HOST, "--port", String(PORT)],
    {
      cwd: ROOT_PATH,
      env: {
        ...process.env,
        SEREN_PROVIDER_RUNTIME_TOKEN: TOKEN,
        SEREN_CLAUDE_SESSION_LIMIT: limit,
        SEREN_SANDBOX_SPEC_BIN: resolveSandboxSpecBin(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const runtimeLog = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        runtimeLog.push(line);
        if (process.env.WALKTHROUGH_VERBOSE === "1" || line.includes("session queued")) {
          console.log("  [runtime] " + line.trim());
        }
      }
    });
  }

  // Wait for the runtime to report healthy rather than guessing a delay.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/__seren/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("provider runtime never became healthy");
    await sleep(500);
  }
  const ws = new WebSocket(`ws://${HOST}:${PORT}`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message ?? "rpc error"));
      else entry.resolve(msg.result);
    } else if (msg.method) {
      notifications.push(msg);
    }
  });
  // The runtime authenticates over an `auth` RPC, not a query parameter.
  await rpc(ws, "auth", { token: TOKEN });

  const spawnClaude = (id) =>
    rpc(ws, "provider_spawn", {
      agentType: "claude-code",
      cwd: CWD,
      localSessionId: id,
      resumeAgentSessionId: null,
      sandboxMode: "full-access",
      apiKey: null,
      approvalPolicy: "on-request",
      searchEnabled: false,
      networkEnabled: true,
      timeoutSecs: 60,
    });

  try {
    console.log(`\n=== STEP 1 — saturate the gate (limit=${limit}) ===`);
    const held = [];
    const holdCount = Number(process.env.WALKTHROUGH_HOLD ?? limit);
    for (let i = 0; i < holdCount; i += 1) {
      const id = randomUUID();
      await spawnClaude(id);
      held.push(id);
      console.log(`  spawned real Claude session ${i + 1}/${holdCount} (limit ${limit})`);
    }

    console.log("\n=== STEP 2 — provider_claude_capacity reports the real holders ===");
    const capacity = await rpc(ws, "provider_claude_capacity", {});
    console.log("  " + JSON.stringify(capacity, null, 2).split("\n").join("\n  "));

    console.log("\n=== STEP 3 — a further spawn queues; the log names the holders ===");
    const queuedId = randomUUID();
    const queuedSpawn = spawnClaude(queuedId).then(
      () => "admitted",
      (error) => `rejected: ${error.message}`,
    );
    await sleep(2000);
    const queuedCapacity = await rpc(ws, "provider_claude_capacity", {});
    console.log(`  pending=${JSON.stringify(queuedCapacity.pending)}`);

    console.log("\n=== STEP 4 — releasing a holder admits the queued spawn ===");
    await rpc(ws, "provider_terminate", { sessionId: held[0] });
    const outcome = await queuedSpawn;
    console.log(`  queued spawn outcome: ${outcome}`);

    const afterCapacity = await rpc(ws, "provider_claude_capacity", {});
    console.log(`  active after admit: ${afterCapacity.active.length}/${afterCapacity.limit}`);

    console.log("\n=== STEP 5 — capacity matches provider_list_sessions (source of truth) ===");
    const sessions = await rpc(ws, "provider_list_sessions", {});
    const claudeSessions = sessions.filter((s) => s.agentType === "claude-code");
    console.log(`  provider_list_sessions claude-code sessions: ${claudeSessions.length}`);
    console.log(`  provider_claude_capacity active holders:     ${afterCapacity.active.length}`);
    const holderIds = new Set(afterCapacity.active.map((h) => h.sessionId));
    const listedIds = new Set(claudeSessions.map((s) => s.id));
    const missing = [...holderIds].filter((id) => !listedIds.has(id));
    console.log(`  holders not present in the session list: ${missing.length}`);

    console.log("\n=== STEP 6 — a paired thread's planner is visible and attributed ===");
    // Root cause 1: the planner is a real claude-code session holding a real
    // slot, but the frontend only ever holds the claude-codex wrapper.
    const pairedId = randomUUID();
    let pairedSpawned = false;
    try {
      await rpc(ws, "provider_spawn", {
        agentType: "claude-codex",
        cwd: CWD,
        localSessionId: pairedId,
        resumeAgentSessionId: null,
        sandboxMode: "full-access",
        apiKey: null,
        approvalPolicy: "on-request",
        searchEnabled: false,
        networkEnabled: true,
        timeoutSecs: 60,
      });
      pairedSpawned = true;
    } catch (error) {
      console.log(`  paired spawn failed: ${error.message}`);
    }

    const pairedCapacity = await rpc(ws, "provider_claude_capacity", {});
    const pairedHolders = pairedCapacity.active.filter(
      (h) => h.ownerAgentType === "claude-codex",
    );
    console.log(`  paired spawn succeeded: ${pairedSpawned}`);
    console.log(`  slot holders attributed to a paired wrapper: ${pairedHolders.length}`);
    for (const holder of pairedHolders) {
      console.log(
        `    inner planner ${holder.sessionId.slice(0, 8)}… (${holder.agentType}, pid ${holder.pid})` +
          ` -> wrapper ${holder.ownerSessionId.slice(0, 8)}… role=${holder.pairedRole}`,
      );
      console.log(
        `    wrapper id matches the paired thread id: ${holder.ownerSessionId === pairedId}`,
      );
    }
    const listed = await rpc(ws, "provider_list_sessions", {});
    const wrapper = listed.find((sess) => sess.id === pairedId);
    console.log(
      `  provider_list_sessions reports the wrapper as: agentType=${wrapper?.agentType} pid=${wrapper?.pid}`,
    );
    console.log(
      "  ^ pid null on the wrapper is exactly why agent-type inference could not see the slot",
    );

    console.log("\n=== QUEUE LOG LINES ===");
    for (const line of runtimeLog.filter((l) => l.includes("session queued"))) {
      console.log("  " + line.trim());
    }
  } finally {
    for (const note of notifications.slice(0, 0)) console.log(note);
    try {
      const remaining = await rpc(ws, "provider_list_sessions", {});
      for (const session of remaining) {
        await rpc(ws, "provider_terminate", { sessionId: session.id }).catch(() => {});
      }
    } catch {
      // teardown best-effort
    }
    ws.close();
    child.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
