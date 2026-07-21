// ABOUTME: Regression coverage for macOS embedded-runtime preparation on a warm tree (#3152).
// ABOUTME: Proves an incremental prepare still replaces the npm/npx/corepack symlinks.

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNodejs } from "../../build/darwin/prepare-embedded-runtime";
import { expect, it } from "vitest";

/**
 * The download is skipped when `<outputDir>/node` already exists, which is the
 * state of every incremental `pnpm prepare:runtime:darwin-*`. That early return
 * used to skip the wrapper replacement with it, leaving the original symlinks
 * in place — and Tauri dereferences symlinks when bundling the .app, which
 * breaks `require('../lib/cli.js')` for npm/npx/corepack.
 *
 * Exercising the real function against a real warm tree also proves the early
 * return still short-circuits the network: the download would fail or hang
 * here, not silently pass.
 */
it("replaces runtime symlinks on an already-prepared node tree", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "seren-warm-runtime-"));
  try {
    const nodeDir = join(outputDir, "node");
    const binDir = join(nodeDir, "bin");
    const targetDir = join(nodeDir, "lib", "node_modules", "npm", "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "npm-cli.js"), "// original npm entrypoint\n");
    symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(binDir, "npm"));
    symlinkSync("../lib/node_modules/npm/bin/npx-cli.js", join(binDir, "npx"));
    symlinkSync("../lib/node_modules/corepack/dist/corepack.js", join(binDir, "corepack"));

    const prepared = await prepareNodejs({ arch: "arm64", outputDir });

    expect(prepared).toBe(nodeDir);
    for (const wrapper of ["npm", "npx", "corepack"]) {
      const wrapperPath = join(binDir, wrapper);
      expect(
        lstatSync(wrapperPath).isSymbolicLink(),
        `${wrapper} must not still be a symlink after an incremental prepare`,
      ).toBe(false);
      expect(readFileSync(wrapperPath, "utf8")).toContain("#!/bin/sh");
    }
    expect(readFileSync(join(targetDir, "npm-cli.js"), "utf8")).toBe(
      "// original npm entrypoint\n",
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
