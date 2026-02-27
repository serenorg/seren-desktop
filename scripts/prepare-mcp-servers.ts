// ABOUTME: Cross-platform script to prepare MCP servers for bundling.
// ABOUTME: Uses pnpm node-linker=hoisted to create flat node_modules without symlinks.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "mcp-servers", "playwright-stealth");
const DEST_PARENT = path.join(ROOT, "src-tauri", "mcp-servers");
const DEST = path.join(DEST_PARENT, "playwright-stealth");

// Main
console.log("Preparing MCP servers...");

// 1. Clean existing node_modules to ensure fresh hoisted install
const nodeModules = path.join(SOURCE, "node_modules");
if (fs.existsSync(nodeModules)) {
	console.log("Cleaning existing node_modules...");
	fs.rmSync(nodeModules, { recursive: true, force: true });
}

// 2. Install with node-linker=hoisted to create flat node_modules WITHOUT symlinks
// This is the documented solution for bundled apps (Electron, Tauri) on Windows
// See: https://pnpm.io/blog/2020/10/17/node-modules-configuration-options-with-pnpm
console.log("Installing dependencies with hoisted node-linker (no symlinks)...");
execSync("pnpm install --node-linker=hoisted", { cwd: SOURCE, stdio: "inherit" });

console.log("Building...");
execSync("pnpm build", { cwd: SOURCE, stdio: "inherit" });

// 3. Clean destination
if (fs.existsSync(DEST_PARENT)) {
	console.log("Cleaning destination...");
	fs.rmSync(DEST_PARENT, { recursive: true, force: true });
}

// 4. Simple copy - no symlink handling needed since hoisted mode creates real files
console.log("Copying to bundle location...");
fs.cpSync(SOURCE, DEST, { recursive: true });

console.log("MCP servers prepared successfully.");
