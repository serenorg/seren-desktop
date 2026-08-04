// ABOUTME: Builds hermetic child-process environments for validation app launches.
// ABOUTME: Keeps app state in the worktree while preserving host toolchain caches.

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
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
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const validationHome = validationHomeForSlot(inputs.repoRoot, inputs.port);
  const validationIdentifier = `com.serendb.desktop.validation.slot${inputs.port}`;
  const platform = inputs.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = {
    ...inputs.baseEnv,
    HOME: validationHome,
    CARGO_HOME:
      inputs.baseEnv.CARGO_HOME ?? path.join(inputs.realHome, ".cargo"),
    RUSTUP_HOME:
      inputs.baseEnv.RUSTUP_HOME ?? path.join(inputs.realHome, ".rustup"),
    SEREN_VALIDATION_DISCOVERY_PATH: path.join(
      validationHome,
      "Library",
      "Application Support",
      validationIdentifier,
      "validation-control.json",
    ),
  };

  // macOS Foundation resolves Tauri's app-data directory from
  // CFFIXED_USER_HOME rather than HOME. Keep the validation app's database,
  // discovery token, and keychain in the same per-slot sandbox after a restart.
  if (platform === "darwin") {
    env.CFFIXED_USER_HOME = validationHome;
  }

  // Windows resolves both Seren's app state and its managed npm prefix from
  // USERPROFILE/APPDATA rather than HOME. Point all three at the disposable
  // slot so a hosted-runner walkthrough proves a genuinely clean first run.
  if (platform === "win32") {
    env.USERPROFILE = validationHome;
    env.APPDATA = path.join(validationHome, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(validationHome, "AppData", "Local");
  }

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
  if (process.platform === "darwin") {
    await ensureValidationKeychain(validationHome, repoRoot);
  }
  return validationHome;
}

export async function ensureValidationKeychain(
  validationHome: string,
  repoRoot: string,
): Promise<void> {
  const resolvedHome = assertValidationHome(validationHome, repoRoot);
  const keychainDirectory = path.join(
    resolvedHome,
    "Library",
    "Keychains",
  );
  const keychainPath = path.join(keychainDirectory, "login.keychain-db");
  await mkdir(keychainDirectory, { recursive: true, mode: 0o700 });

  const keychainPassword = `seren-validation-keychain-${path.basename(resolvedHome)}`;
  const securityEnv = {
    ...process.env,
    HOME: resolvedHome,
  };
  const security = (args: string[]) =>
    execFileAsync("security", args, { env: securityEnv });
  const slot = path.basename(resolvedHome).replace(/^slot/, "");
  console.log(
    `[validation] scratch keychain password for slot ${slot} (safe to type into a Keychain prompt for login.keychain-db under artifacts/validation-home): ${keychainPassword}`,
  );
  let keychainExists = true;
  try {
    await stat(keychainPath);
  } catch {
    keychainExists = false;
  }

  if (!keychainExists) {
    await security([
      "create-keychain",
      "-p",
      keychainPassword,
      keychainPath,
    ]);
  }

  // Keep validation's app data hermetic while making the slot keychain the
  // only user keychain visible to its security-tool mutations and the app.
  await bestEffortSecurity(
    security,
    ["set-keychain-settings", keychainPath],
  );
  await bestEffortSecurity(security, [
    "unlock-keychain",
    "-p",
    keychainPassword,
    keychainPath,
  ]);
  await bestEffortSecurity(security, [
    "default-keychain",
    "-d",
    "user",
    "-s",
    keychainPath,
  ]);
  await bestEffortSecurity(security, [
    "list-keychains",
    "-d",
    "user",
    "-s",
    keychainPath,
  ]);
}

async function bestEffortSecurity(
  security: (args: string[]) => Promise<unknown>,
  args: string[],
): Promise<void> {
  try {
    await security(args);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
    console.warn(
      `[validation] security ${args[0]} did not complete; continuing for interactive keychain authorization: ${detail}`,
    );
  }
}

function assertValidationHome(validationHome: string, repoRoot: string): string {
  const resolvedHome = path.resolve(validationHome);
  const validationRoot = path.resolve(
    repoRoot,
    "artifacts",
    "validation-home",
  );
  const relativeHome = path.relative(validationRoot, resolvedHome);
  if (
    relativeHome.length === 0 ||
    relativeHome.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeHome)
  ) {
    throw new Error(
      `refusing security mutation outside validation HOME: ${resolvedHome}`,
    );
  }
  return resolvedHome;
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("validation port must be an integer from 1 to 65535");
  }
}
