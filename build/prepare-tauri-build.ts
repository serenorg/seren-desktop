// ABOUTME: Runs all resource preparation required before `tauri build`.
// ABOUTME: Keeps platform runtimes, Windows Python, MCP servers, and provider runtime in one build hook.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

type RuntimePlatform = "darwin" | "linux" | "win32";
type RuntimeArch = "arm64" | "x64";

export interface RuntimeTarget {
  platform: RuntimePlatform;
  arch: RuntimeArch;
}

export interface ResolveRuntimeTargetInput {
  env?: Record<string, string | undefined>;
  hostArch?: string;
  hostPlatform?: string;
  targetTriple?: string;
}

export interface TauriPreparationCommand {
  label: string;
  command: string;
  args: string[];
}

function normalizePlatform(platform: string): RuntimePlatform {
  switch (platform) {
    case "darwin":
    case "macos":
      return "darwin";
    case "linux":
      return "linux";
    case "windows":
    case "win32":
      return "win32";
    default:
      throw new Error(`Unsupported Tauri build platform: ${platform}`);
  }
}

function normalizeArch(arch: string): RuntimeArch {
  switch (arch) {
    case "aarch64":
    case "arm64":
      return "arm64";
    case "x64":
    case "x86_64":
      return "x64";
    default:
      throw new Error(`Unsupported Tauri build architecture: ${arch}`);
  }
}

function targetFromTriple(targetTriple: string): RuntimeTarget | null {
  const arch = targetTriple.startsWith("aarch64-")
    ? "arm64"
    : targetTriple.startsWith("x86_64-")
      ? "x64"
      : null;

  if (!arch) return null;

  if (targetTriple.includes("apple-darwin")) {
    return { platform: "darwin", arch };
  }
  if (targetTriple.includes("unknown-linux")) {
    return { platform: "linux", arch };
  }
  if (targetTriple.includes("pc-windows-msvc")) {
    return { platform: "win32", arch };
  }

  return null;
}

function targetTripleFromEnv(env: Record<string, string | undefined>): string | undefined {
  return (
    env.TAURI_TARGET_TRIPLE ||
    env.TAURI_ENV_TARGET_TRIPLE ||
    env.CARGO_BUILD_TARGET ||
    env.TARGET_TRIPLE ||
    env.TARGET
  );
}

export function resolveRuntimeTarget(input: ResolveRuntimeTargetInput = {}): RuntimeTarget {
  const env = input.env ?? process.env;
  if (input.targetTriple) {
    const target = targetFromTriple(input.targetTriple);
    if (target) return target;
  }

  const tauriPlatform = env.TAURI_ENV_PLATFORM;
  const tauriArch = env.TAURI_ENV_ARCH;
  if (tauriPlatform && tauriArch) {
    return {
      platform: normalizePlatform(tauriPlatform),
      arch: normalizeArch(tauriArch),
    };
  }

  const envTarget = targetTripleFromEnv(env);
  if (envTarget) {
    const target = targetFromTriple(envTarget);
    if (target) return target;
  }

  return {
    platform: normalizePlatform(input.hostPlatform ?? process.platform),
    arch: normalizeArch(input.hostArch ?? process.arch),
  };
}

export function buildTauriPreparationCommands(
  target: RuntimeTarget,
): TauriPreparationCommand[] {
  const commands: TauriPreparationCommand[] = [
    {
      label: "Prepare MCP servers",
      command: "pnpm",
      args: ["prepare:mcp-servers"],
    },
    {
      label: "Build provider runtime",
      command: "pnpm",
      args: ["build:provider-runtime"],
    },
    {
      label: `Prepare embedded runtime (${target.platform}-${target.arch})`,
      command: "pnpm",
      args: [`prepare:runtime:${target.platform}-${target.arch}`],
    },
  ];

  if (target.platform === "win32") {
    commands.push({
      label: `Prepare embedded Python (${target.platform}-${target.arch})`,
      command: "pnpm",
      args: [`prepare:python:${target.platform}-${target.arch}`],
    });
  }

  commands.push({
    label: "Sign embedded runtime",
    command: "pnpm",
    args: ["sign:embedded-runtime"],
  });

  return commands;
}

function executableFor(command: string): string {
  if (process.platform === "win32" && command === "pnpm") {
    return "pnpm.cmd";
  }
  return command;
}

function runCommand(command: TauriPreparationCommand): void {
  console.log(`[prepare-tauri-build] ${command.label}`);
  const result = spawnSync(executableFor(command.command), command.args, {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command.command} ${command.args.join(" ")} failed with exit code ${result.status}`,
    );
  }
}

export function prepareTauriBuild(): void {
  const target = resolveRuntimeTarget();
  console.log(
    `[prepare-tauri-build] Resolved Tauri runtime target: ${target.platform}-${target.arch}`,
  );

  for (const command of buildTauriPreparationCommands(target)) {
    runCommand(command);
  }
}

const isCli = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isCli) {
  try {
    prepareTauriBuild();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
