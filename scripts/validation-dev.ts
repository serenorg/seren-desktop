// ABOUTME: Starts a manual validation Tauri app in an automatically leased slot.
// ABOUTME: Releases the slot after the Tauri process and its dev server exit.

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  removeValidationBuildFlag,
  shouldSkipValidationBuild,
  validationDevArgs,
} from "./validation-dev-args";
import {
  ensureValidationHome,
  resolvePnpmStoreDir,
  validationChildEnv,
} from "./validation-env";
import { acquireValidationSlot } from "./validation-slots";

async function main(): Promise<void> {
  const slot = await acquireValidationSlot();
  const rawArgs = validationDevArgs(process.argv.slice(2));
  // --no-build is the human-facing flag; SEREN_VALIDATION_SKIP_BUILD=1 is
  // the first-class escape hatch for scripted relaunches.
  const skipBuild = shouldSkipValidationBuild(rawArgs, process.env);
  const forwardedArgs = removeValidationBuildFlag(rawArgs);

  try {
    const validationHome = await ensureValidationHome(process.cwd(), slot.port);
    const pnpmStoreDir = await resolvePnpmStoreDir();
    const childEnv = {
      ...validationChildEnv({
        baseEnv: process.env,
        port: slot.port,
        repoRoot: process.cwd(),
        realHome: os.homedir(),
        pnpmStoreDir,
      }),
      SEREN_VALIDATION_DEV_PORT: String(slot.port),
      SEREN_VALIDATION_INSTANCE: "1",
    };

    console.log(
      `[validation] leased port ${slot.port} with identifier ${slot.identifier}; scratch home ${validationHome}`,
    );

    const children: ChildProcess[] = [];
    const repoRoot = process.cwd();
    const validationBinary = path.join(
      repoRoot,
      "src-tauri",
      "target",
      "debug",
      process.platform === "win32" ? "Seren.exe" : "Seren",
    );

    if (skipBuild) {
      await assertValidationBinary(validationBinary);
      const vite = spawn(
        "pnpm",
        [
          "dev",
          "--host",
          "127.0.0.1",
          "--port",
          String(slot.port),
          "--strictPort",
        ],
        {
          cwd: repoRoot,
          stdio: "inherit",
          env: childEnv,
        },
      );
      children.push(vite);
      await waitForDevServer(`http://127.0.0.1:${slot.port}`, vite);
      children.push(
        spawn(validationBinary, forwardedArgs, {
          cwd: path.join(repoRoot, "src-tauri"),
          stdio: "inherit",
          env: childEnv,
        }),
      );
    } else {
      children.push(
        spawn(
          "pnpm",
          [
            "tauri",
            "dev",
            "--features",
            "validation",
            "--config",
            "src-tauri/tauri.validation.conf.json",
            "--config",
            JSON.stringify(slot.tauriConfig),
            ...forwardedArgs,
          ],
          {
            cwd: repoRoot,
            stdio: "inherit",
            env: childEnv,
          },
        ),
      );
    }

    const child = children.at(-1);
    if (!child) throw new Error("validation launcher did not start a child");

    const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
    for (const signal of forwardedSignals) {
      process.once(signal, () => {
        for (const runningChild of children) {
          if (runningChild.exitCode === null) runningChild.kill(signal);
        }
      });
    }

    const result = await waitForChild(child);

    if (result.signal) {
      process.exitCode = result.signal === "SIGINT" ? 130 : 143;
    } else {
      process.exitCode = result.code ?? 1;
    }

    for (const runningChild of children) {
      if (runningChild !== child && runningChild.exitCode === null) {
        runningChild.kill("SIGTERM");
      }
    }
  } finally {
    await slot.release();
  }
}

async function assertValidationBinary(binaryPath: string): Promise<void> {
  try {
    await access(binaryPath, constants.X_OK);
  } catch {
    throw new Error(
      `Validation binary not found at ${binaryPath}; run pnpm tauri:validation:dev once without --no-build first`,
    );
  }
}

async function waitForDevServer(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("validation Vite server exited before becoming ready");
    }
    try {
      const response = await Promise.race([
        fetch(`${baseUrl}/`),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), 1_000),
        ),
      ]);
      if (response instanceof Response && response.ok) return;
    } catch {
      // The dev server may need several polls while pnpm starts Vite.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for validation Vite at ${baseUrl}`);
}

function waitForChild(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
