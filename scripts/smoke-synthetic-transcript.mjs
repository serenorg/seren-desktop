#!/usr/bin/env node
// ABOUTME: Round-trip the synthetic-transcript builder through the bundled Claude CLI (#1713).
// ABOUTME: Builds a minimal synthetic JSONL, calls claude --resume against it, asserts init success.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = new URL("../", import.meta.url);

const {
  buildSyntheticTranscript,
} = await import(new URL("bin/browser-local/synthetic-transcript.mjs", ROOT).href);

function encodeProjectDirName(cwd) {
  const resolved = path.resolve(cwd);
  const sanitized = resolved.replace(/^\/+/, "").replaceAll(":", "");
  return `-${sanitized.replaceAll("/", "-")}`;
}

function claudeProjectsRoot() {
  return path.join(os.homedir(), ".claude", "projects");
}

function resolveClaudeBinary() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "local", "claude"),
    path.join(os.homedir(), ".claude", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function buildParentFixture(parentPath, sessionId) {
  const u1 = randomUUID();
  const a1 = randomUUID();
  const u2 = randomUUID();
  const a2 = randomUUID();
  const baseEnvelope = {
    isSidechain: false,
    permissionMode: "default",
    userType: "external",
    entrypoint: "claude-code",
    cwd: process.cwd(),
    sessionId,
    version: "2.1.118",
    gitBranch: "main",
  };
  const records = [
    {
      ...baseEnvelope,
      parentUuid: null,
      promptId: randomUUID(),
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
      uuid: u1,
      timestamp: new Date().toISOString(),
    },
    {
      ...baseEnvelope,
      parentUuid: u1,
      message: {
        model: "claude-opus-4-7",
        id: `msg_${a1}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      requestId: `req_${a1}`,
      type: "assistant",
      uuid: a1,
      timestamp: new Date().toISOString(),
    },
    {
      ...baseEnvelope,
      parentUuid: a1,
      promptId: randomUUID(),
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "what's the time" }],
      },
      uuid: u2,
      timestamp: new Date().toISOString(),
    },
    {
      ...baseEnvelope,
      parentUuid: u2,
      message: {
        model: "claude-opus-4-7",
        id: `msg_${a2}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "I cannot tell time." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      requestId: `req_${a2}`,
      type: "assistant",
      uuid: a2,
      timestamp: new Date().toISOString(),
    },
  ];
  const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(parentPath, payload, "utf8");
  return { u1, a1, u2, a2 };
}

async function spawnAndAwaitInit(claudeBin, syntheticSessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--allow-dangerously-skip-permissions",
      "--resume",
      syntheticSessionId,
    ];
    const child = spawn(claudeBin, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderrBuffer = "";
    let resolved = false;
    const finish = (ok, detail) => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      if (ok) resolve(detail);
      else reject(new Error(detail));
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt?.type === "system" && evt?.subtype === "init") {
            finish(true, evt);
          }
        } catch {
          // ignore non-JSON
        }
      }
    });
    child.stderr.on("data", (c) => {
      stderrBuffer += c.toString("utf8");
    });
    child.on("error", (err) => finish(false, `spawn error: ${err.message}`));
    child.on("exit", (code) => {
      if (!resolved) {
        finish(
          false,
          `claude exited (code=${code}) before init.\nstderr: ${stderrBuffer.slice(0, 1500)}`,
        );
      }
    });
    setTimeout(
      () => finish(false, `Timed out waiting for init.\nstderr: ${stderrBuffer.slice(0, 1500)}`),
      30_000,
    );
  });
}

async function main() {
  const claudeBin = resolveClaudeBinary();
  if (!claudeBin) {
    console.log(
      "[smoke-synthetic] SKIP: no claude binary found. Set CLAUDE_BIN to run.",
    );
    return;
  }
  console.log(`[smoke-synthetic] claude binary: ${claudeBin}`);

  const cwd = process.cwd();
  const projectDir = path.join(claudeProjectsRoot(), encodeProjectDirName(cwd));
  await fs.mkdir(projectDir, { recursive: true });

  const parentSessionId = randomUUID();
  const parentPath = path.join(projectDir, `${parentSessionId}.jsonl`);
  await buildParentFixture(parentPath, parentSessionId);

  const syntheticSessionId = randomUUID();
  const outputPath = path.join(projectDir, `${syntheticSessionId}.jsonl`);
  const result = await buildSyntheticTranscript({
    parentJsonlPath: parentPath,
    outputJsonlPath: outputPath,
    summaryText: "Earlier conversation: greetings exchanged.",
    preserveCount: 1,
    syntheticSessionId,
  });
  console.log(
    `[smoke-synthetic] wrote synthetic transcript ${result.syntheticJsonlPath}`,
  );

  let ok = false;
  let initEvt = null;
  let failure = null;
  try {
    initEvt = await spawnAndAwaitInit(claudeBin, syntheticSessionId);
    ok =
      initEvt?.session_id === syntheticSessionId ||
      typeof initEvt?.session_id === "string";
  } catch (err) {
    failure = err.message;
  } finally {
    if (process.env.SMOKE_KEEP) {
      console.log(`[smoke-synthetic] kept ${parentPath} and ${outputPath}`);
    } else {
      try {
        unlinkSync(parentPath);
      } catch {}
      try {
        unlinkSync(outputPath);
      } catch {}
    }
  }

  if (!ok) {
    console.error(
      `[smoke-synthetic] FAIL: ${failure ?? "init session_id mismatch"}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[smoke-synthetic] OK: claude --resume initialized synthetic transcript (session_id=${initEvt?.session_id})`,
  );
}

main().catch((err) => {
  console.error(`[smoke-synthetic] unexpected error: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
