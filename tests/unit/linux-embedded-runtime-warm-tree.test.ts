// ABOUTME: Regression coverage for Linux embedded-runtime preparation on a warm tree (#3449).
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
import { NODE_VERSION, prepareNodejs } from "../../build/linux/prepare-embedded-runtime";
import { writeStagedNodeVersion } from "../../build/runtime-staging";
import { expect, it } from "vitest";

/**
 * The Linux Node tarball ships bin/npm, bin/npx and bin/corepack as the same
 * relative symlinks as the darwin one, and the bundler dereferences symlinks
 * the same way — but the Linux prepare script historically never replaced them
 * with wrappers (#3449). Exercising the real function against a real warm tree
 * proves both the wrapper replacement and that the version-matched early
 * return still short-circuits the network: the download would fail or hang
 * here, not silently pass.
 */
it("replaces runtime symlinks on an already-prepared node tree", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "seren-linux-warm-runtime-"));
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
    // A warm tree only skips the download when its staged-node-version marker
    // matches NODE_VERSION; anything else is re-staged (#3450).
    writeStagedNodeVersion(outputDir, NODE_VERSION);

    const prepared = await prepareNodejs({ arch: "x64", outputDir });

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
