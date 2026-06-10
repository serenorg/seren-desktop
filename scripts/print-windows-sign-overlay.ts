// ABOUTME: CLI entrypoint that prints the tauri --config overlay enabling native Windows signing via signCommand (#2294).
// ABOUTME: CI-only — keeps signCommand out of tauri.conf.json so contributor Windows builds never attempt to sign.

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.argv[2];
if (!root || process.argv.length > 3) {
  console.error("usage: print-windows-sign-overlay.ts <absolute-workspace-root>");
  process.exit(2);
}
if (!path.isAbsolute(root)) {
  console.error(`workspace root must be absolute, got: ${root}`);
  process.exit(2);
}

// Absolute path is load-bearing: the bundler absolutizes relative args against
// its own cwd, and makensis runs the !uninstfinalize sign hook from another
// directory entirely.
const signer = path.join(root, "scripts", "sign-windows-payload.ps1");
if (!existsSync(signer)) {
  console.error(`signer script not found: ${signer}`);
  process.exit(1);
}

// Object notation (CustomSignCommandConfig): args are passed as argv tokens,
// so paths with spaces survive. "%1" must stay a standalone token — the
// bundler only substitutes exact-match args. The signer resolves its
// thumbprint from WINDOWS_SIGN_THUMBPRINT, exported by the eSigner CKA step.
const overlay = {
  bundle: {
    windows: {
      signCommand: {
        cmd: "pwsh",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signer, "-File", "%1"],
      },
    },
  },
};

process.stdout.write(`${JSON.stringify(overlay, null, 2)}\n`);
