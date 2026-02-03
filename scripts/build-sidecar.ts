// ABOUTME: Builds ACP agent sidecars from git repositories or local paths
// ABOUTME: Reads configuration from sidecars section in package.json

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type Profile = "debug" | "release";

interface SidecarEntry {
  name: string;
  git?: string;
  path?: string;
  rev?: string;
  tag?: string;
  branch?: string;
  bin: string;
  dest: string;
  optional?: boolean;
}

interface PackageJson {
  sidecars?: Record<string, SidecarEntry>;
}

type SidecarSource =
  | { type: "git"; url: string; rev?: string; tag?: string; branch?: string }
  | { type: "path"; dir: string };

interface SidecarConfig {
  key: string;
  name: string;
  source: SidecarSource;
  binName: string;
  destName: string;
  optional: boolean;
}

function usage(): void {
  console.log(`
Usage: pnpm build:sidecar [debug|release] [--target <triple>]

Builds ACP agent sidecars defined in package.json "sidecars" section.
Each entry must specify either:
  - "git" with one of "rev", "tag", or "branch"
  - "path" for local development

Examples:
  pnpm build:sidecar
  pnpm build:sidecar release
  pnpm build:sidecar --target x86_64-apple-darwin

Environment overrides:
  ACP_SIDECAR_FORCE_REINSTALL=1 (force cargo install/rebuild)
  ACP_SIDECAR_TARGET_TRIPLE
  TAURI_ENV_TARGET_TRIPLE
  TAURI_SIDECAR_TARGET_TRIPLE
  TARGET_TRIPLE
  CARGO_BUILD_TARGET
`);
}

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

function sanitizePathSegment(input: string): string {
  return input.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function deriveTargetFromTauriEnv(): string | undefined {
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (triple) return triple;

  const platform = process.env.TAURI_ENV_PLATFORM?.trim();
  const arch = process.env.TAURI_ENV_ARCH?.trim();
  if (!platform || !arch) return undefined;

  switch (platform) {
    case "darwin":
    case "macos":
      return `${arch}-apple-darwin`;
    case "linux":
      return `${arch}-unknown-linux-gnu`;
    case "windows":
      return `${arch}-pc-windows-msvc`;
    default:
      return undefined;
  }
}

function parseArgs(argv: string[]): { profile: Profile; target?: string } {
  let profile: Profile = "debug";
  let target: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "debug" || arg === "release") {
      profile = arg;
      continue;
    }
    if (arg === "--target") {
      target = argv[i + 1];
      if (!target) {
        throw new Error("--target requires a value");
      }
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { profile, target };
}

function resolveTargetTriple(cliTarget?: string): string {
  if (cliTarget) return cliTarget;

  const envTarget =
    process.env.ACP_SIDECAR_TARGET_TRIPLE?.trim() ||
    process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
    process.env.TAURI_SIDECAR_TARGET_TRIPLE?.trim() ||
    process.env.TARGET_TRIPLE?.trim() ||
    process.env.CARGO_BUILD_TARGET?.trim();
  if (envTarget) return envTarget;

  return deriveTargetFromTauriEnv() ?? "";
}

function loadSidecarsFromPackageJson(rootDir: string): SidecarConfig[] {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }

  const content = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(content) as PackageJson;

  if (!pkg.sidecars) {
    throw new Error('No "sidecars" section found in package.json');
  }

  const configs: SidecarConfig[] = [];
  for (const [key, entry] of Object.entries(pkg.sidecars)) {
    let source: SidecarSource;

    if (entry.path) {
      // Local path source
      if (entry.git || entry.rev || entry.tag || entry.branch) {
        throw new Error(
          `Sidecar "${key}" has "path" but also git fields. Use either "path" or "git", not both.`,
        );
      }
      const resolvedPath = path.resolve(rootDir, entry.path);
      if (!existsSync(resolvedPath)) {
        throw new Error(`Sidecar "${key}" path does not exist: ${resolvedPath}`);
      }
      source = { type: "path", dir: resolvedPath };
    } else if (entry.git) {
      // Git source
      const gitRev = entry.rev?.trim();
      const gitTag = entry.tag?.trim();
      const gitBranch = entry.branch?.trim();
      const numPins = [gitRev, gitTag, gitBranch].filter(Boolean).length;
      if (numPins !== 1) {
        throw new Error(
          `Sidecar "${key}" must specify exactly one of "rev", "tag", or "branch" when using "git"`,
        );
      }
      source = { type: "git", url: entry.git, rev: gitRev, tag: gitTag, branch: gitBranch };
    } else {
      throw new Error(`Sidecar "${key}" must specify either "git" or "path"`);
    }

    configs.push({
      key,
      name: entry.name,
      source,
      binName: entry.bin,
      destName: entry.dest,
      optional: entry.optional ?? false,
    });
  }

  return configs;
}

function cargoTargetDir(cwd: string): string {
  const jsonText = execText("cargo", ["metadata", "--format-version", "1", "--no-deps"], cwd);
  const parsed = JSON.parse(jsonText) as { target_directory?: unknown };
  if (typeof parsed.target_directory !== "string" || !parsed.target_directory.trim()) {
    throw new Error(`cargo metadata did not return target_directory for ${cwd}`);
  }
  return parsed.target_directory;
}

function buildSidecar(
  config: SidecarConfig,
  profile: Profile,
  targetTriple: string,
  hostTriple: string,
  srcTauriDir: string,
  binDir: string,
): boolean {
  const { name, source, binName, destName, optional } = config;

  console.log(`\nBuilding ${name}:`);
  if (source.type === "path") {
    console.log(`  path:    ${source.dir}`);
  } else {
    console.log(`  git:     ${source.url}`);
    if (source.rev) console.log(`  rev:     ${source.rev.slice(0, 12)}...`);
    if (source.tag) console.log(`  tag:     ${source.tag}`);
    if (source.branch) console.log(`  branch:  ${source.branch}`);
  }
  console.log(`  target:  ${targetTriple}`);
  console.log(`  profile: ${profile}`);

  const ext = targetTriple.includes("windows") ? ".exe" : "";
  const forceInstall = process.env.ACP_SIDECAR_FORCE_REINSTALL?.trim() === "1";
  const profileDir = profile === "release" ? "release" : "debug";

  let srcBin: string;

  if (source.type === "path") {
    // Build from local path using cargo build
    const cargoArgs = ["build", "--bin", binName];
    if (profile === "release") cargoArgs.push("--release");
    if (targetTriple !== hostTriple) cargoArgs.push("--target", targetTriple);

    try {
      run("cargo", cargoArgs, source.dir);
    } catch (err) {
      if (optional) {
        console.log(`  Warning: ${name} build failed; agent will be unavailable`);
        return true;
      }
      throw err;
    }

    const targetDir = cargoTargetDir(source.dir);
    const cargoTargetDirPath =
      targetTriple === hostTriple ? targetDir : path.join(targetDir, targetTriple);
    srcBin = path.join(cargoTargetDirPath, profileDir, `${binName}${ext}`);
  } else {
    // Build from git using cargo install
    const versionKey = source.rev
      ? `rev-${source.rev.slice(0, 12)}`
      : source.tag
        ? `tag-${source.tag}`
        : source.branch
          ? `branch-${source.branch}`
          : "unpinned";
    const versionSegment = sanitizePathSegment(versionKey);
    const installRoot = path.join(
      srcTauriDir,
      "target",
      "sidecar-install",
      `${destName}-${versionSegment}-${targetTriple}-${profile}`,
    );

    srcBin = path.join(installRoot, "bin", `${binName}${ext}`);

    if (!forceInstall && existsSync(srcBin)) {
      console.log(`  Using cached install at ${srcBin}`);
    } else {
      mkdirSync(installRoot, { recursive: true });

      const baseArgs = ["install", "--git", source.url];
      if (source.rev) {
        baseArgs.push("--rev", source.rev);
      } else if (source.tag) {
        baseArgs.push("--tag", source.tag);
      } else if (source.branch) {
        baseArgs.push("--branch", source.branch);
      }
      baseArgs.push("--bin", binName, "--root", installRoot);
      if (profile === "debug") baseArgs.push("--debug");
      if (targetTriple !== hostTriple) baseArgs.push("--target", targetTriple);
      if (forceInstall) baseArgs.push("--force");

      try {
        run("cargo", [...baseArgs, "--locked"]);
      } catch {
        // Fallback: some repos may not ship a lockfile or may require updating it.
        try {
          run("cargo", baseArgs);
        } catch (err) {
          if (optional) {
            console.log(`  Warning: ${name} build failed; agent will be unavailable`);
            return true;
          }
          throw err;
        }
      }
    }
  }

  if (!existsSync(srcBin)) {
    if (optional) {
      console.log(`  Warning: Built binary not found at ${srcBin}`);
      return true;
    }
    throw new Error(`Built binary not found at: ${srcBin}`);
  }

  const destBin = path.join(binDir, `${destName}${ext}`);
  copyFileSync(srcBin, destBin);

  try {
    chmodSync(destBin, 0o755);
  } catch {
    // Ignore chmod failures on Windows/filesystems that don't support it.
  }

  console.log(`  Copied to ${destBin}`);
  return true;
}

function main(): void {
  const { profile, target: cliTarget } = parseArgs(process.argv.slice(2));

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, "..");
  const srcTauriDir = path.join(rootDir, "src-tauri");

  const hostTriple = execText("rustc", ["--print", "host-tuple"]);
  const targetTriple = resolveTargetTriple(cliTarget) || hostTriple;

  const sidecars = loadSidecarsFromPackageJson(rootDir);

  console.log("Building sidecars from package.json:");
  console.log(`  host:    ${hostTriple}`);
  console.log(`  target:  ${targetTriple}`);
  console.log(`  profile: ${profile}`);
  console.log(`  count:   ${sidecars.length}`);

  const binDir = path.join(srcTauriDir, "embedded-runtime", "bin");
  mkdirSync(binDir, { recursive: true });

  for (const sidecar of sidecars) {
    buildSidecar(sidecar, profile, targetTriple, hostTriple, srcTauriDir, binDir);
  }

  console.log("\nDone.");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  usage();
  process.exit(1);
}
