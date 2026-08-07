// ABOUTME: Live walkthrough for #3729 against a real provider runtime and the real Codex CLI.
// ABOUTME: Exercises invalidated-token detection, auth status, and login-required recovery.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";

const ROOT_PATH = fileURLToPath(new URL("../", import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.WALKTHROUGH_PORT ?? "4321");
const TOKEN = "walkthrough-3729-token";
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
    console.log("\n=== STEP 1 — codex availability BEFORE any observed rejection ===");
    const before = await rpc(ws, "provider_get_available_agents", {});
    const codexBefore = before.find((a) => a.type === "codex");
    console.log(`  codex authenticated: ${codexBefore?.authenticated}`);
    console.log(`  (auth.json exists on disk, so file-presence alone says "yes")`);

    console.log("\n=== STEP 2 — ask Codex for its model catalog (real upstream call) ===");
    let catalogError = null;
    try {
      const models = await rpc(ws, "provider_get_model_catalog", {
        agentType: "codex",
        cwd: CWD,
      });
      console.log(`  model catalog returned ${models.length} models — token is valid`);
    } catch (error) {
      catalogError = error.message;
      console.log(`  model catalog FAILED with:`);
      console.log(`    ${catalogError}`);
    }

    console.log("\n=== STEP 3 — availability AFTER the observed rejection ===");
    const after = await rpc(ws, "provider_get_available_agents", {});
    const codexAfter = after.find((a) => a.type === "codex");
    console.log(`  codex authenticated: ${codexAfter?.authenticated}`);

    console.log("\n=== STEP 4 — spawn Codex and watch for login-required ===");
    const codexId = randomUUID();
    let spawnError = null;
    try {
      await rpc(ws, "provider_spawn", {
        agentType: "codex",
        cwd: CWD,
        localSessionId: codexId,
        resumeAgentSessionId: null,
        sandboxMode: "full-access",
        apiKey: null,
        approvalPolicy: "on-request",
        searchEnabled: false,
        networkEnabled: true,
        timeoutSecs: 60,
      });
      console.log("  codex spawn succeeded");
      console.log("  sending a real prompt (this must reach upstream)...");
      try {
        await rpc(ws, "provider_prompt", {
          sessionId: codexId,
          prompt: "Reply with exactly: PONG",
          context: [],
        });
        console.log("  prompt completed — credential is valid");
      } catch (error) {
        console.log(`  prompt failed: ${error.message}`);
      }
      await sleep(3000);
      await rpc(ws, "provider_terminate", { sessionId: codexId }).catch(() => {});
    } catch (error) {
      spawnError = error.message;
      console.log(`  codex spawn failed: ${spawnError}`);
    }
    const loginEvents = notifications.filter(
      (n) => n.method === "provider://login-required",
    );
    console.log(`  provider://login-required events observed: ${loginEvents.length}`);
    for (const evt of loginEvents) {
      console.log(`    agentType=${evt.params?.agentType} sessionId=${evt.params?.sessionId?.slice(0, 8)}…`);
    }

    console.log("\n=== STEP 5 — availability after a REAL observed rejection ===");
    const final = await rpc(ws, "provider_get_available_agents", {});
    const codexFinal = final.find((a) => a.type === "codex");
    console.log(`  codex authenticated: ${codexFinal?.authenticated}`);
    console.log(
      `  unavailableReason: ${codexFinal?.unavailableReason ?? "(none)"}`,
    );

    console.log("\n=== SUMMARY ===");
    console.log(`  catalog error classified as auth: ${catalogError ? catalogError.includes("sign-in required") : "n/a (token valid)"}`);
    console.log(`  authenticated before -> after: ${codexBefore?.authenticated} -> ${codexAfter?.authenticated}`);
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
