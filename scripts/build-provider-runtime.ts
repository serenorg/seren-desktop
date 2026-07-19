// ABOUTME: Bundles the desktop provider runtime into src-tauri/embedded-runtime.
// ABOUTME: Copies the local runtime entrypoints and installs the minimal Node dependency set.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function run(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

function ensureCliWrappers(destDir: string): void {
  const binDir = path.join(destDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const unixWrapper = path.join(binDir, "seren-provider-runtime");
  writeFileSync(
    unixWrapper,
    '#!/bin/sh\nexec node "$(dirname "$0")/../provider-runtime/provider-runtime.mjs" "$@"\n',
    "utf8",
  );
  chmodSync(unixWrapper, 0o755);

  const winWrapper = path.join(binDir, "seren-provider-runtime.cmd");
  writeFileSync(
    winWrapper,
    '@node "%~dp0\\..\\provider-runtime\\provider-runtime.mjs" %*\r\n',
    "utf8",
  );
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const embeddedRuntimeDir = path.join(repoRoot, "src-tauri", "embedded-runtime");
  const destDir = path.join(embeddedRuntimeDir, "provider-runtime");
  const browserLocalSrcDir = path.join(repoRoot, "bin", "browser-local");
  const markerPath = path.join(destDir, ".seren-provider-runtime-bundle.json");

  const rootPackageJson = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const wsVersion = rootPackageJson.dependencies?.ws ?? "^8.19.0";
  // lmstudio-runtime.mjs statically imports @lmstudio/sdk at provider-runtime
  // startup (provider-runtime.mjs -> providers.mjs -> lmstudio-runtime.mjs), so
  // the package must be present in the bundle or the runtime exits before it
  // becomes ready (#2456).
  const lmstudioSdkVersion = rootPackageJson.dependencies?.["@lmstudio/sdk"] ?? "1.5.0";
  const happyVersion = rootPackageJson.dependencies?.happy ?? "1.2.0";
  const tweetnaclVersion = rootPackageJson.dependencies?.tweetnacl ?? "1.0.3";
  const happyWireVersion = rootPackageJson.dependencies?.["@slopus/happy-wire"] ?? "0.1.0";

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  cpSync(
    path.join(repoRoot, "bin", "provider-runtime.mjs"),
    path.join(destDir, "provider-runtime.mjs"),
  );
  cpSync(
    path.join(repoRoot, "bin", "happy-bridge.mjs"),
    path.join(destDir, "happy-bridge.mjs"),
  );
  cpSync(path.join(repoRoot, "bin", "happy-bridge"), path.join(destDir, "happy-bridge"), {
    recursive: true,
  });
  cpSync(browserLocalSrcDir, path.join(destDir, "browser-local"), {
    recursive: true,
  });

  writeFileSync(
    path.join(destDir, "package.json"),
    JSON.stringify(
      {
        name: "@seren/provider-runtime",
        private: true,
        version: "0.1.0",
        type: "module",
        dependencies: {
          "@lmstudio/sdk": lmstudioSdkVersion,
          "@slopus/happy-wire": happyWireVersion,
          happy: happyVersion,
          tweetnacl: tweetnaclVersion,
          ws: wsVersion,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  // Use --node-linker=hoisted to create real files instead of pnpm symlinks.
  // Symlinks don't survive Tauri bundling or macOS notarization, so without
  // this the ws package is missing from the app bundle at runtime.
  run(
    "pnpm",
    ["install", "--prod", "--ignore-workspace", "--ignore-scripts", "--node-linker=hoisted"],
    destDir,
  );

  const bundleNodeModules = path.join(destDir, "node_modules");
  const bundleSizeBeforePrune = spawnSync("du", ["-sh", bundleNodeModules], {
    encoding: "utf8",
  }).stdout.trim();
  console.log(`provider-runtime/node_modules before Happy SDK binary prune: ${bundleSizeBeforePrune}`);
  const happyPackage = path.join(bundleNodeModules, "happy");
  const happyReferenceRoot = existsSync(path.join(happyPackage, "lib"))
    ? path.join(happyPackage, "lib")
    : path.join(happyPackage, "dist");
  const happyReferenceCheck = spawnSync("grep", ["-rl", "claude-agent-sdk", happyReferenceRoot], {
    encoding: "utf8",
  });
  const scanFailed = Boolean(happyReferenceCheck.error) || happyReferenceCheck.status === null;
  const referencesSdk = happyReferenceCheck.status === 0;
  if (scanFailed || referencesSdk || happyReferenceCheck.status !== 1) {
    console.warn(
      `Skipping Happy SDK binary prune: ${scanFailed ? "reference scan failed" : referencesSdk ? "happy/lib references the SDK" : "unexpected scan result"}`,
    );
  }
  const anthropicModules = path.join(bundleNodeModules, "@anthropic-ai");
  if (!scanFailed && !referencesSdk && happyReferenceCheck.status === 1 && existsSync(anthropicModules)) {
    for (const entry of readdirSync(anthropicModules, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("claude-agent-sdk-")) {
        rmSync(path.join(anthropicModules, entry.name), { recursive: true, force: true });
      }
    }
  }
  const bundleSize = spawnSync("du", ["-sh", bundleNodeModules], { encoding: "utf8" })
    .stdout.trim();
  console.log(`provider-runtime/node_modules after Happy SDK binary prune: ${bundleSize}`);

  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        dependencies: {
          "@lmstudio/sdk": lmstudioSdkVersion,
          "@slopus/happy-wire": happyWireVersion,
          happy: happyVersion,
          tweetnacl: tweetnaclVersion,
          ws: wsVersion,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  ensureCliWrappers(embeddedRuntimeDir);
  console.log(`[build-provider-runtime] Bundled provider runtime into ${destDir}`);
}

main();
