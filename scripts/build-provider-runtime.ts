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
  const workspaceHappyDist = path.join(
    repoRoot,
    "node_modules",
    "happy",
    "dist",
  );
  const bundledHappyDist = path.join(happyPackage, "dist");
  if (!existsSync(workspaceHappyDist)) {
    throw new Error(
      "Workspace Happy dependency is missing; run pnpm install before building the provider runtime",
    );
  }
  // The isolated install above intentionally ignores the root workspace, so it
  // cannot see pnpm-workspace.yaml's patchedDependencies entry. Replace its raw
  // Happy distribution with the already-patched workspace distribution before
  // this directory becomes the production Tauri resource bundle.
  rmSync(bundledHappyDist, { recursive: true, force: true });
  cpSync(workspaceHappyDist, bundledHappyDist, {
    recursive: true,
    force: true,
    dereference: true,
  });
  const sdkPackage = path.join(bundleNodeModules, "@anthropic-ai", "claude-agent-sdk");
  const happyReferenceRoot = existsSync(path.join(happyPackage, "lib"))
    ? path.join(happyPackage, "lib")
    : path.join(happyPackage, "dist");
  const platformBinaryPattern =
    "(from[[:space:]]+|import[[:space:]]*\\(|require[[:space:]]*\\()[[:space:]]*['\"][^'\"]*claude-agent-sdk-(linux-x64|linux-arm64|linux-x64-musl|linux-arm64-musl|darwin-x64|darwin-arm64|win32-x64|win32-arm64)[^'\"]*['\"]";
  // Keep the SDK JS package: Happy's types chunk embeds its version string and
  // declares the JS package as a regular dependency. Only its optional,
  // platform-specific native binaries are prunable; Seren runs agents through
  // its provider runtime and never invokes Happy's agent-runner modules.
  const happyReferenceCheck = spawnSync(
    "grep",
    [
      "-REl",
      "--include=*.js",
      "--include=*.mjs",
      "--include=*.cjs",
      platformBinaryPattern,
      happyReferenceRoot,
      sdkPackage,
    ],
    { encoding: "utf8" },
  );
  const scanFailed = Boolean(happyReferenceCheck.error) || happyReferenceCheck.status === null;
  const referencesBinary = happyReferenceCheck.status === 0;
  if (scanFailed || referencesBinary || happyReferenceCheck.status !== 1) {
    const matchedFiles = referencesBinary ? happyReferenceCheck.stdout.trim() : "";
    console.warn(
      `Skipping Happy SDK binary prune: ${scanFailed ? "reference scan failed" : referencesBinary ? `binary specifier found in ${matchedFiles}` : "unexpected scan result"}`,
    );
  }
  const anthropicModules = path.join(bundleNodeModules, "@anthropic-ai");
  if (!scanFailed && !referencesBinary && happyReferenceCheck.status === 1 && existsSync(anthropicModules)) {
    for (const entry of readdirSync(anthropicModules, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("claude-agent-sdk-")) {
        rmSync(path.join(anthropicModules, entry.name), { recursive: true, force: true });
      }
    }
  }
  // Happy vendors ripgrep and difftastic as per-platform tarballs under
  // `tools/archives`. Apple's notary service reads inside archives, so the
  // unsigned Mach-O binaries in the darwin tarballs get the whole DMG rejected
  // ("The binary is not signed", "does not have the hardened runtime enabled").
  // That blocked the v3.71.0 macOS release (#3048).
  //
  // They are also dead weight: the binaries are resolved from `tools/unpacked`,
  // which only its postinstall creates, and the install above runs with
  // `--ignore-scripts`. The guard below keeps that reasoning honest — if a
  // future change ever does unpack them, the prune backs off instead of
  // silently deleting something that became load-bearing.
  const happyTools = path.join(happyPackage, "tools");
  const happyArchives = path.join(happyTools, "archives");
  if (existsSync(happyArchives)) {
    if (existsSync(path.join(happyTools, "unpacked"))) {
      console.warn("Skipping Happy tool archive prune: tools/unpacked exists, archives may be in use");
    } else {
      // `tools/licenses` is deliberately kept for attribution.
      rmSync(happyArchives, { recursive: true, force: true });
      console.log("Pruned happy/tools/archives (unsigned platform binaries)");
    }
  }

  // `ps-list` arrives as a Happy dependency and vendors two prebuilt Windows
  // executables. They are only reached by `ps-list`'s `windows()` branch, and
  // nothing on the bridge's load path reaches `ps-list` at all: the bridge
  // imports `happy/lib` only, and loading that entry pulls 246 modules with
  // `ps-list` among none of them. Its importers are Happy's CLI and
  // agent-runner entrypoints, which Seren never invokes.
  //
  // Signing them would apply Seren's EV certificate to vendored third-party
  // binaries and bill two extra SSL.com operations on every release.
  //
  // The guard checks the entry the bridge actually loads: if a future Happy
  // version makes `lib` depend on `ps-list`, the prune backs off.
  const psListVendor = path.join(bundleNodeModules, "ps-list", "vendor");
  if (existsSync(psListVendor)) {
    const happyLibEntry = path.join(happyPackage, "dist", "lib.cjs");
    const libUsesPsList =
      existsSync(happyLibEntry) && readFileSync(happyLibEntry, "utf8").includes("ps-list");
    if (libUsesPsList) {
      console.warn("Skipping ps-list vendor prune: happy/lib references ps-list");
    } else {
      for (const entry of readdirSync(psListVendor, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
          rmSync(path.join(psListVendor, entry.name), { force: true });
        }
      }
      console.log("Pruned ps-list/vendor executables (unreachable from the bridge)");
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
