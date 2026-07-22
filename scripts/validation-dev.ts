// ABOUTME: Starts a manual validation Tauri app in an automatically leased slot.
// ABOUTME: Releases the slot after the Tauri process and its dev server exit.

import { spawn } from "node:child_process";
import os from "node:os";
import { validationDevArgs } from "./validation-dev-args";
import {
  ensureValidationHome,
  resolvePnpmStoreDir,
  validationChildEnv,
} from "./validation-env";
import { acquireValidationSlot } from "./validation-slots";

async function main(): Promise<void> {
  const slot = await acquireValidationSlot();
  const forwardedArgs = validationDevArgs(process.argv.slice(2));

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

    const child = spawn(
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
        cwd: process.cwd(),
        stdio: "inherit",
        env: childEnv,
      },
    );

    const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
    for (const signal of forwardedSignals) {
      process.once(signal, () => child.kill(signal));
    }

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    if (result.signal) {
      process.exitCode = result.signal === "SIGINT" ? 130 : 143;
    } else {
      process.exitCode = result.code ?? 1;
    }
  } finally {
    await slot.release();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
