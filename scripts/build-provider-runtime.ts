// ABOUTME: Bundles the desktop provider runtime into src-tauri/embedded-runtime.
// ABOUTME: Copies the local runtime entrypoints and installs the minimal Node dependency set.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
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

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  cpSync(
    path.join(repoRoot, "bin", "provider-runtime.mjs"),
    path.join(destDir, "provider-runtime.mjs"),
  );
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
          ws: wsVersion,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  run("pnpm", ["install", "--prod", "--ignore-scripts"], destDir);

  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        dependencies: {
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
