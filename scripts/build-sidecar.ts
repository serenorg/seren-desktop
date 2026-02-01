import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type Profile = "debug" | "release";

type SidecarSource =
  | { type: "path"; cargoDir: string }
  | { type: "git"; gitUrl: string; gitRev?: string; gitTag?: string };

interface SidecarConfig {
  name: string;
  source: SidecarSource;
  /** Binary name (cargo build output) */
  binName: string;
  /** Destination filename in embedded-runtime/bin */
  destName: string;
  optional?: boolean;
}

function usage(): void {
  console.log(`
Usage: pnpm build:sidecar [debug|release] [--target <triple>]

Builds ACP agent sidecars:
  - Claude Code: serenorg/claude-code-acp-rs
  - Codex: serenorg/seren-acp-codex

Examples:
  pnpm build:sidecar
  pnpm build:sidecar release
  pnpm build:sidecar --target x86_64-apple-darwin

Environment overrides (highest priority first):
  CLAUDE_ACP_GIT_REV (optional; pin git revision)
  ACP_SIDECAR_FORCE_REINSTALL=1 (optional; force cargo install)
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
      // Hook commands no longer receive TAURI_ENV_PLATFORM_TYPE; assume MSVC.
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
    console.log(`  cargo:   ${source.cargoDir}`);
  } else {
    console.log(`  git:     ${source.gitUrl}`);
    if (source.gitRev) console.log(`  rev:     ${source.gitRev}`);
    if (!source.gitRev && source.gitTag) console.log(`  tag:     ${source.gitTag}`);
  }
  console.log(`  target:  ${targetTriple}`);
  console.log(`  profile: ${profile}`);

  const ext = targetTriple.includes("windows") ? ".exe" : "";
  const profileDir = profile === "release" ? "release" : "debug";

  let srcBin: string;

  if (source.type === "path") {
    const cargoArgs = ["build", "--bin", binName];
    if (profile === "release") cargoArgs.push("--release");
    if (targetTriple !== hostTriple) cargoArgs.push("--target", targetTriple);

    try {
      run("cargo", cargoArgs, source.cargoDir);
    } catch (err) {
      if (optional) {
        console.log(`  Warning: ${name} build failed; agent will be unavailable`);
        return true;
      }
      throw err;
    }

    const targetDir = cargoTargetDir(source.cargoDir);
    const cargoTargetDirPath =
      targetTriple === hostTriple ? targetDir : path.join(targetDir, targetTriple);

    srcBin = path.join(cargoTargetDirPath, profileDir, `${binName}${ext}`);
  } else {
    const forceInstall = process.env.ACP_SIDECAR_FORCE_REINSTALL?.trim() === "1";
    const versionKey = source.gitRev
      ? `rev-${source.gitRev.slice(0, 12)}`
      : source.gitTag
        ? `tag-${source.gitTag}`
        : "unpinned";
    const versionSegment = sanitizePathSegment(versionKey);
    const installRoot = path.join(
      srcTauriDir,
      "target",
      "sidecar-install",
      `${destName}-${versionSegment}-${targetTriple}-${profile}`,
    );

    // cargo install always installs to <root>/bin regardless of profile/target
    srcBin = path.join(installRoot, "bin", `${binName}${ext}`);

    if (!forceInstall && existsSync(srcBin)) {
      console.log(`  Using cached install at ${srcBin}`);
    } else {
      mkdirSync(installRoot, { recursive: true });

      const baseArgs = ["install", "--git", source.gitUrl];
      if (source.gitRev) {
        baseArgs.push("--rev", source.gitRev);
      } else if (source.gitTag) {
        baseArgs.push("--tag", source.gitTag);
      }
      baseArgs.push("--bin", binName, "--root", installRoot);
      if (profile === "debug") baseArgs.push("--debug");
      if (targetTriple !== hostTriple) baseArgs.push("--target", targetTriple);
      if (forceInstall) baseArgs.push("--force");

      try {
        run("cargo", [...baseArgs, "--locked"]);
      } catch (err) {
        // Fallback: some repos may not ship a lockfile or may require updating it.
        run("cargo", baseArgs);
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

  console.log("Building sidecars:");
  console.log(`  host:    ${hostTriple}`);
  console.log(`  target:  ${targetTriple}`);
  console.log(`  profile: ${profile}`);

  const binDir = path.join(srcTauriDir, "embedded-runtime", "bin");
  mkdirSync(binDir, { recursive: true });

  // Agent sidecars built out-of-tree (keeps Seren Desktop's Cargo graph lean)
  const claudeGitUrl = "https://github.com/serenorg/claude-code-acp-rs";
  const claudeGitRev = process.env.CLAUDE_ACP_GIT_REV?.trim();
  const codexGitUrl = "https://github.com/serenorg/seren-acp-codex";
  // Bump this tag when cutting a new seren-acp-codex release.
  const codexGitTag = "v0.1.0";

  const sidecars: SidecarConfig[] = [
    {
      name: "Claude Code",
      source: { type: "git", gitUrl: claudeGitUrl, gitRev: claudeGitRev },
      binName: "claude-code-acp-rs",
      destName: "seren-claude-acp-agent",
      optional: false,
    },
    {
      name: "Codex",
      source: { type: "git", gitUrl: codexGitUrl, gitTag: codexGitTag },
      binName: "seren-acp-codex",
      destName: "seren-acp-codex",
      optional: false,
    },
  ];

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
