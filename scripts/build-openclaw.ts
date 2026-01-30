import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function execText(cmd: string, args: string[], cwd?: string): string {
  const res = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${res.status}): ${res.stderr ?? ""}`.trim(),
    );
  }
  return (res.stdout ?? "").trim();
}

function run(cmd: string, args: string[], cwd?: string): void {
  const res = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
  }
}

function runAndTail(cmd: string, args: string[], cwd: string, tailLines: number): void {
  const res = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;

  const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd();
  if (combined) {
    const lines = combined.split(/\r?\n/);
    const tail = lines.slice(-tailLines).join("\n");
    if (tail) process.stdout.write(`${tail}\n`);
  }

  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
  }
}

function resolveOpenClawDir(repoRoot: string): string {
  const envDir = process.env.OPENCLAW_DIR?.trim();
  if (envDir) return path.resolve(envDir);

  // Try sibling of repo root first, then sibling of git toplevel (for worktrees)
  const sibling = path.resolve(repoRoot, "..", "openclaw");
  if (existsSync(sibling)) return sibling;

  let gitTopLevel = repoRoot;
  try {
    gitTopLevel = execText("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"]) || repoRoot;
  } catch {
    // fall back to repoRoot
  }

  return path.resolve(path.dirname(gitTopLevel), "openclaw");
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(fullPath);
    } else if (entry.isFile()) {
      total += statSync(fullPath).size;
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fixed = unitIndex === 0 ? `${Math.round(value)}` : value.toFixed(1);
  return `${fixed}${units[unitIndex]}`;
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const destDir = path.join(repoRoot, "src-tauri", "embedded-runtime");

  const openclawDir = resolveOpenClawDir(repoRoot);
  if (!existsSync(openclawDir)) {
    throw new Error(
      `OpenClaw repo not found at ${openclawDir}. Set OPENCLAW_DIR to your OpenClaw checkout.`,
    );
  }

  console.log(`[build-openclaw] Source: ${openclawDir}`);
  console.log(`[build-openclaw] Destination: ${destDir}`);

  // --- 1. Build openclaw if dist/ is missing ---
  if (!existsSync(path.join(openclawDir, "dist"))) {
    console.log("[build-openclaw] Building openclaw...");
    run("pnpm", ["build"], openclawDir);
  }

  // --- 2. Create openclaw directory in embedded-runtime ---
  const openclawRuntimeDir = path.join(destDir, "openclaw");
  rmSync(openclawRuntimeDir, { recursive: true, force: true });
  mkdirSync(openclawRuntimeDir, { recursive: true });

  console.log("[build-openclaw] Copying openclaw dist...");
  cpSync(path.join(openclawDir, "dist"), path.join(openclawRuntimeDir, "dist"), { recursive: true });
  copyFileSync(path.join(openclawDir, "openclaw.mjs"), path.join(openclawRuntimeDir, "openclaw.mjs"));
  copyFileSync(path.join(openclawDir, "package.json"), path.join(openclawRuntimeDir, "package.json"));

  // Copy skills and assets if they exist
  for (const dirName of ["skills", "assets", "extensions"]) {
    const srcDir = path.join(openclawDir, dirName);
    if (existsSync(srcDir)) {
      cpSync(srcDir, path.join(openclawRuntimeDir, dirName), { recursive: true });
    }
  }

  console.log("[build-openclaw] Installing production dependencies...");
  runAndTail("pnpm", ["install", "--prod", "--ignore-scripts"], openclawRuntimeDir, 5);

  // --- 3. Create the openclaw wrapper script ---
  const wrapperPath = path.join(destDir, "bin", "openclaw");
  mkdirSync(path.dirname(wrapperPath), { recursive: true });

  const wrapperLines = [
    "#!/usr/bin/env bash",
    "# ABOUTME: Wrapper script that launches openclaw gateway via Node.js.",
    "",
    "set -euo pipefail",
    "",
    "# Default OpenClaw gateway env vars if not already set by the parent process",
    'export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-3100}"',
    'export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"',
    'export OPENCLAW_GATEWAY_HOST="${OPENCLAW_GATEWAY_HOST:-127.0.0.1}"',
    "",
    "# Disable channels that aren't configured (faster startup)",
    "# Channels are connected dynamically via the Seren UI",
    'export OPENCLAW_SKIP_CHANNELS="${OPENCLAW_SKIP_CHANNELS:-1}"',
    "",
    "# Resolve the openclaw package directory (sibling to bin/)",
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'OPENCLAW_PKG="$SCRIPT_DIR/../openclaw"',
    "",
    'if [ ! -f "$OPENCLAW_PKG/openclaw.mjs" ]; then',
    '  echo "[openclaw] ERROR: openclaw.mjs not found at $OPENCLAW_PKG" >&2',
    "  exit 1",
    "fi",
    "",
    "# Find node: prefer embedded runtime, then system",
    "if command -v node >/dev/null 2>&1; then",
    '  NODE_BIN="node"',
    "else",
    '  echo "[openclaw] ERROR: Node.js not found in PATH" >&2',
    "  exit 1",
    "fi",
    "",
    'NODE_VERSION=$($NODE_BIN --version 2>/dev/null || echo "unknown")',
    'echo "[openclaw] Starting gateway on ${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_GATEWAY_PORT} (node $NODE_VERSION)" >&2',
    "",
    'exec "$NODE_BIN" "$OPENCLAW_PKG/openclaw.mjs" gateway',
  ];

  const wrapper = `${wrapperLines.join("\n")}\n`;

  writeFileSync(wrapperPath, wrapper, { encoding: "utf8" });
  try {
    chmodSync(wrapperPath, 0o755);
  } catch {
    // Match the bash script on Unix (fail if chmod fails), but allow Windows to proceed.
    if (process.platform !== "win32") throw new Error(`Failed to chmod +x: ${wrapperPath}`);
  }

  console.log(`[build-openclaw] Done. Wrapper at: ${wrapperPath}`);
  console.log(`[build-openclaw] OpenClaw package at: ${openclawRuntimeDir}`);

  let sizeText = "";
  try {
    sizeText = execText("du", ["-sh", openclawRuntimeDir]).split(/\s+/)[0] ?? "";
  } catch {
    sizeText = formatBytes(dirSizeBytes(openclawRuntimeDir));
  }
  if (sizeText) console.log(`[build-openclaw] Total size: ${sizeText}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
