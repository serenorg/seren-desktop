import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type Profile = "debug" | "release";

function usage(): void {
  console.log(`
Usage: pnpm build:sidecar [debug|release] [--target <triple>]

Examples:
  pnpm build:sidecar
  pnpm build:sidecar release
  pnpm build:sidecar --target x86_64-apple-darwin

Environment overrides (highest priority first):
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

function main(): void {
  const { profile, target: cliTarget } = parseArgs(process.argv.slice(2));

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, "..");
  const srcTauriDir = path.join(rootDir, "src-tauri");

  const hostTriple = execText("rustc", ["--print", "host-tuple"]);

  const targetTriple = resolveTargetTriple(cliTarget) || hostTriple;

  console.log("Building acp_agent sidecar:");
  console.log(`  target:  ${targetTriple}`);
  console.log(`  host:    ${hostTriple}`);
  console.log(`  profile: ${profile}`);

  const ext = targetTriple.includes("windows") ? ".exe" : "";
  const profileDir = profile === "release" ? "release" : "debug";

  const cargoArgs = ["build", "--bin", "acp_agent"];
  if (profile === "release") cargoArgs.push("--release");
  if (targetTriple !== hostTriple) cargoArgs.push("--target", targetTriple);

  // Set SKIP_TAURI_BUILD to prevent build.rs from running tauri_build::build(),
  // which validates that the sidecar binary exists — creating a circular dependency.
  process.env.SKIP_TAURI_BUILD = "1";
  run("cargo", cargoArgs, srcTauriDir);

  const cargoTargetDir =
    targetTriple === hostTriple
      ? path.join(srcTauriDir, "target")
      : path.join(srcTauriDir, "target", targetTriple);

  const srcBin = path.join(cargoTargetDir, profileDir, `acp_agent${ext}`);
  if (!existsSync(srcBin)) {
    throw new Error(`Built binary not found at: ${srcBin}`);
  }

  const binDir = path.join(srcTauriDir, "binaries");
  mkdirSync(binDir, { recursive: true });

  const destBin = path.join(binDir, `acp_agent-${targetTriple}${ext}`);
  copyFileSync(srcBin, destBin);

  try {
    chmodSync(destBin, 0o755);
  } catch {
    // Ignore chmod failures on Windows/filesystems that don't support it.
  }

  console.log(`Copied to ${destBin}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  usage();
  process.exit(1);
}
