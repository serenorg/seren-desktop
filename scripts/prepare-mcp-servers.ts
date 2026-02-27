// ABOUTME: Cross-platform script to prepare MCP servers for bundling.
// ABOUTME: Copies mcp-servers to src-tauri, dereferencing pnpm symlinks.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "mcp-servers", "playwright-stealth");
const DEST_PARENT = path.join(ROOT, "src-tauri", "mcp-servers");
const DEST = path.join(DEST_PARENT, "playwright-stealth");

// Helper to copy directory recursively, dereferencing symlinks
function copyDirDeref(src: string, dest: string): void {
	fs.mkdirSync(dest, { recursive: true });

	const entries = fs.readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);

		// Resolve symlinks to get the real path
		const realPath = fs.realpathSync(srcPath);
		const stat = fs.statSync(realPath);

		if (stat.isDirectory()) {
			copyDirDeref(realPath, destPath);
		} else {
			fs.copyFileSync(realPath, destPath);
		}
	}
}

// Main
console.log("Preparing MCP servers...");

// 1. Install and build playwright-stealth
console.log("Installing dependencies...");
execSync("pnpm install --frozen-lockfile", { cwd: SOURCE, stdio: "inherit" });

console.log("Building...");
execSync("pnpm build", { cwd: SOURCE, stdio: "inherit" });

// 2. Clean destination
if (fs.existsSync(DEST_PARENT)) {
	console.log("Cleaning destination...");
	fs.rmSync(DEST_PARENT, { recursive: true, force: true });
}

// 3. Copy with symlink dereferencing
console.log("Copying with symlink dereferencing...");
copyDirDeref(SOURCE, DEST);

console.log("MCP servers prepared successfully.");
