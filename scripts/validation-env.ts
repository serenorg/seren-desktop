// ABOUTME: Builds hermetic child-process environments for validation app launches.
// ABOUTME: Keeps app state in the worktree while preserving host toolchain caches.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function validationHomeForSlot(repoRoot: string, port: number): string {
  assertValidPort(port);
  return path.join(repoRoot, "artifacts", "validation-home", `slot${port}`);
}

export function validationChildEnv(inputs: {
  baseEnv: NodeJS.ProcessEnv;
  port: number;
  repoRoot: string;
  realHome: string;
  pnpmStoreDir?: string | null;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...inputs.baseEnv,
    HOME: validationHomeForSlot(inputs.repoRoot, inputs.port),
    CARGO_HOME:
      inputs.baseEnv.CARGO_HOME ?? path.join(inputs.realHome, ".cargo"),
    RUSTUP_HOME:
      inputs.baseEnv.RUSTUP_HOME ?? path.join(inputs.realHome, ".rustup"),
  };

  if (inputs.pnpmStoreDir != null) {
    env.npm_config_store_dir = inputs.pnpmStoreDir;
  }

  return env;
}

export async function resolvePnpmStoreDir(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("pnpm", ["store", "path"]);
    const storeDir = stdout.trim();
    return storeDir || null;
  } catch {
    return null;
  }
}

export async function ensureValidationHome(
  repoRoot: string,
  port: number,
): Promise<string> {
  const validationHome = validationHomeForSlot(repoRoot, port);
  await mkdir(validationHome, { recursive: true, mode: 0o700 });
  return validationHome;
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("validation port must be an integer from 1 to 65535");
  }
}
