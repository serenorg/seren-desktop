// ABOUTME: Signs all native binaries in embedded-runtime and mcp-servers for macOS notarization.
// ABOUTME: Runs automatically when APPLE_SIGNING_IDENTITY env var is set.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SIGNABLE_EXTENSIONS = new Set([".node", ".dylib", ".so"]);

// Entitlements file for embedded binaries (provides JIT permissions for V8/Node.js)
const ENTITLEMENTS_PLIST = "embedded-runtime-entitlements.plist";

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
      // .app bundles are directories — sign as a unit, don't recurse into them.
      // Skip fake .app dirs inside node_modules (e.g., puppeteer-stealth evasions/chrome.app).
      if (entry.name.endsWith(".app")) {
        if (!fullPath.includes("node_modules")) {
          files.push(fullPath);
        }
      } else {
        files.push(...findSignableFiles(fullPath));
      }
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
  const entitlementsPath = path.join(repoRoot, "src-tauri", ENTITLEMENTS_PLIST);

  // Directories containing native binaries that must be signed for notarization
  const scanDirs = [
    path.join(repoRoot, "src-tauri", "embedded-runtime"),
    path.join(repoRoot, "src-tauri", "mcp-servers"),
  ];

  console.log(`[sign-embedded-runtime] Identity: ${signingIdentity.slice(0, 20)}...`);

  if (!existsSync(entitlementsPath)) {
    console.error(`[sign-embedded-runtime] Entitlements file not found: ${entitlementsPath}`);
    process.exit(1);
  }
  console.log(`[sign-embedded-runtime] Entitlements: ${ENTITLEMENTS_PLIST}`);

  const files: string[] = [];
  for (const dir of scanDirs) {
    if (!existsSync(dir)) {
      console.log(`[sign-embedded-runtime] Skipping (not found): ${dir}`);
      continue;
    }
    console.log(`[sign-embedded-runtime] Scanning: ${dir}`);
    files.push(...findSignableFiles(dir));
  }

  if (files.length === 0) {
    console.log("[sign-embedded-runtime] No signable files found.");
    return;
  }

  console.log(`[sign-embedded-runtime] Found ${files.length} files to sign.`);

  let signed = 0;
  let failed = 0;

  for (const file of files) {
    const relativePath = path.relative(path.join(repoRoot, "src-tauri"), file);
    process.stdout.write(`  Signing: ${relativePath}... `);

    const isAppBundle = file.endsWith(".app");
    const args = [
      "--sign",
      signingIdentity,
      "--options",
      "runtime",
      "--entitlements",
      entitlementsPath,
      "--timestamp",
      "--force",
    ];
    // .app bundles are directories — sign their contents recursively
    if (isAppBundle) {
      args.push("--deep");
    }
    args.push(file);

    const success = run("codesign", args);

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
