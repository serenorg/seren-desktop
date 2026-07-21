// ABOUTME: Starts a manual validation Tauri app in an automatically leased slot.
// ABOUTME: Releases the slot after the Tauri process and its dev server exit.

import { spawn } from "node:child_process";
import { acquireValidationSlot } from "./validation-slots";

async function main(): Promise<void> {
  const slot = await acquireValidationSlot();
  const forwardedArgs = process.argv.slice(2);
  if (forwardedArgs[0] === "--") forwardedArgs.shift();
  console.log(
    `[validation] leased port ${slot.port} with identifier ${slot.identifier}`,
  );

  try {
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
        env: {
          ...process.env,
          SEREN_VALIDATION_DEV_PORT: String(slot.port),
          SEREN_VALIDATION_INSTANCE: "1",
        },
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
