// ABOUTME: Cross-platform script to prepare MCP servers for bundling.
// ABOUTME: Uses pnpm node-linker=hoisted to create flat node_modules without symlinks.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "mcp-servers", "playwright-stealth");
const DEST_PARENT = path.join(ROOT, "src-tauri", "mcp-servers");
const DEST = path.join(DEST_PARENT, "playwright-stealth");
const DEST_NEW = path.join(DEST_PARENT, "playwright-stealth.new");
const DEST_OLD = path.join(DEST_PARENT, "playwright-stealth.old");
const RM_RETRY_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

// Main
console.log("Preparing MCP servers...");

// 1. Clean existing node_modules to ensure fresh hoisted install
const nodeModules = path.join(SOURCE, "node_modules");
if (fs.existsSync(nodeModules)) {
	console.log("Cleaning existing node_modules...");
	fs.rmSync(nodeModules, RM_RETRY_OPTS);
}

// 2. Install with node-linker=hoisted to create flat node_modules WITHOUT symlinks
// This is the documented solution for bundled apps (Electron, Tauri) on Windows
// See: https://pnpm.io/blog/2020/10/17/node-modules-configuration-options-with-pnpm
console.log("Installing dependencies with hoisted node-linker (no symlinks)...");
execSync("pnpm install --node-linker=hoisted", { cwd: SOURCE, stdio: "inherit" });

console.log("Building...");
execSync("pnpm build", { cwd: SOURCE, stdio: "inherit" });

// 3. Atomic swap: copy to sibling, then rename into place.
//
// The previous implementation wiped DEST_PARENT then cpSync'd the source back,
// leaving a ~1-3s window where src-tauri/mcp-servers/playwright-stealth/ did not
// exist. Tauri's build script walks that tree on fresh builds to emit
// `rerun-if-changed` entries for bundle resources and aborts with
// "resource path doesn't exist" if a file vanishes mid-walk. Running both
// concurrently via `beforeDevCommand` reliably raced on cold builds (#1505).
//
// Two renameSync calls on the same filesystem shrink that window to a few
// microseconds, narrow enough that the walker will not observe a missing dest.
fs.mkdirSync(DEST_PARENT, { recursive: true });

if (fs.existsSync(DEST_NEW)) {
	fs.rmSync(DEST_NEW, RM_RETRY_OPTS);
}
console.log("Staging new bundle at playwright-stealth.new...");
fs.cpSync(SOURCE, DEST_NEW, { recursive: true });

if (fs.existsSync(DEST_OLD)) {
	fs.rmSync(DEST_OLD, RM_RETRY_OPTS);
}

console.log("Swapping into place...");
if (fs.existsSync(DEST)) {
	fs.renameSync(DEST, DEST_OLD);
}
fs.renameSync(DEST_NEW, DEST);

if (fs.existsSync(DEST_OLD)) {
	fs.rmSync(DEST_OLD, RM_RETRY_OPTS);
}

console.log("MCP servers prepared successfully.");
