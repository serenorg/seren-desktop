// ABOUTME: Builds ACP agent sidecars from git repositories
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
  git: string;
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

interface SidecarConfig {
  key: string;
  name: string;
  gitUrl: string;
  gitRev?: string;
  gitTag?: string;
  gitBranch?: string;
  binName: string;
  destName: string;
  optional: boolean;
}

function usage(): void {
  console.log(`
Usage: pnpm build:sidecar [debug|release] [--target <triple>]

Builds ACP agent sidecars defined in package.json "sidecars" section.
Each entry must specify exactly one git reference: "rev", "tag", or "branch".

Examples:
  pnpm build:sidecar
  pnpm build:sidecar release
  pnpm build:sidecar --target x86_64-apple-darwin

Environment overrides:
  ACP_SIDECAR_FORCE_REINSTALL=1 (force cargo install)
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
    const gitRev = entry.rev?.trim();
    const gitTag = entry.tag?.trim();
    const gitBranch = entry.branch?.trim();
    const numPins = [gitRev, gitTag, gitBranch].filter(Boolean).length;
    if (numPins !== 1) {
      throw new Error(
        `Sidecar "${key}" must specify exactly one of "rev", "tag", or "branch" in package.json`,
      );
    }

    configs.push({
      key,
      name: entry.name,
      gitUrl: entry.git,
      gitRev,
      gitTag,
      gitBranch,
      binName: entry.bin,
      destName: entry.dest,
      optional: entry.optional ?? false,
    });
  }

  return configs;
}

function buildSidecar(
  config: SidecarConfig,
  profile: Profile,
  targetTriple: string,
  hostTriple: string,
  srcTauriDir: string,
  binDir: string,
): boolean {
  const { name, gitUrl, gitRev, gitTag, gitBranch, binName, destName, optional } = config;

  console.log(`\nBuilding ${name}:`);
  console.log(`  git:     ${gitUrl}`);
  if (gitRev) console.log(`  rev:     ${gitRev.slice(0, 12)}...`);
  if (!gitRev && gitTag) console.log(`  tag:     ${gitTag}`);
  if (!gitRev && !gitTag && gitBranch) console.log(`  branch:  ${gitBranch}`);
  console.log(`  target:  ${targetTriple}`);
  console.log(`  profile: ${profile}`);

  const ext = targetTriple.includes("windows") ? ".exe" : "";
  const forceInstall = process.env.ACP_SIDECAR_FORCE_REINSTALL?.trim() === "1";

  const versionKey = gitRev
    ? `rev-${gitRev.slice(0, 12)}`
    : gitTag
      ? `tag-${gitTag}`
      : gitBranch
        ? `branch-${gitBranch}`
        : "unpinned";
  const versionSegment = sanitizePathSegment(versionKey);
  const installRoot = path.join(
    srcTauriDir,
    "target",
    "sidecar-install",
    `${destName}-${versionSegment}-${targetTriple}-${profile}`,
  );

  const srcBin = path.join(installRoot, "bin", `${binName}${ext}`);

  if (!forceInstall && existsSync(srcBin)) {
    console.log(`  Using cached install at ${srcBin}`);
  } else {
    mkdirSync(installRoot, { recursive: true });

    const baseArgs = ["install", "--git", gitUrl];
    if (gitRev) {
      baseArgs.push("--rev", gitRev);
    } else if (gitTag) {
      baseArgs.push("--tag", gitTag);
    } else if (gitBranch) {
      baseArgs.push("--branch", gitBranch);
    } else {
      throw new Error(`Sidecar "${config.key}" has no git ref (rev/tag/branch)`);
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
