// ABOUTME: Signs all native binaries in embedded-runtime for macOS notarization
// ABOUTME: Runs automatically when APPLE_SIGNING_IDENTITY env var is set

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SIGNABLE_EXTENSIONS = new Set([".node", ".dylib", ".so"]);

function run(cmd: string, args: string[]): boolean {
  const res = spawnSync(cmd, args, {
    env: process.env,
    stdio: "inherit",
  });
  if (res.error) {
    console.error(`  Error running ${cmd}:`, res.error.message);
    return false;
  }
  return res.status === 0;
}

function isSignable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (SIGNABLE_EXTENSIONS.has(ext)) return true;

  // Check for executable binaries without extension (like seren-acp-claude)
  if (ext === "") {
    try {
      const stat = statSync(filePath);
      // Check if executable (any execute bit set)
      // eslint-disable-next-line no-bitwise
      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

function findSignableFiles(dir: string): string[] {
  const files: string[] = [];

  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findSignableFiles(fullPath));
    } else if (entry.isFile() && isSignable(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function main(): void {
  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();

  if (process.platform !== "darwin") {
    console.log("[sign-embedded-runtime] Not macOS; skipping.");
    return;
  }

  if (!signingIdentity) {
    console.log("[sign-embedded-runtime] No APPLE_SIGNING_IDENTITY set; skipping.");
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const embeddedRuntimeDir = path.join(repoRoot, "src-tauri", "embedded-runtime");

  console.log(`[sign-embedded-runtime] Scanning: ${embeddedRuntimeDir}`);
  console.log(`[sign-embedded-runtime] Identity: ${signingIdentity.slice(0, 20)}...`);

  const files = findSignableFiles(embeddedRuntimeDir);

  if (files.length === 0) {
    console.log("[sign-embedded-runtime] No signable files found.");
    return;
  }

  console.log(`[sign-embedded-runtime] Found ${files.length} files to sign.`);

  let signed = 0;
  let failed = 0;

  for (const file of files) {
    const relativePath = path.relative(embeddedRuntimeDir, file);
    process.stdout.write(`  Signing: ${relativePath}... `);

    const success = run("codesign", [
      "--sign",
      signingIdentity,
      "--options",
      "runtime",
      "--timestamp",
      "--force",
      file,
    ]);

    if (success) {
      console.log("OK");
      signed += 1;
    } else {
      console.log("FAILED");
      failed += 1;
    }
  }

  console.log(`[sign-embedded-runtime] Done. Signed: ${signed}, Failed: ${failed}`);

  if (failed > 0) {
    console.error("[sign-embedded-runtime] Some files failed to sign!");
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
