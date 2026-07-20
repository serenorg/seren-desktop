// ABOUTME: Critical regression coverage for macOS embedded-runtime wrapper preparation (#3086).
// ABOUTME: Proves replacing an extracted npm symlink never overwrites its JavaScript target.

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
import { replaceRuntimeShim } from "../../build/darwin/prepare-embedded-runtime";
import { expect, it } from "vitest";

it("replaces an npm symlink without corrupting its target", () => {
  const root = mkdtempSync(join(tmpdir(), "seren-runtime-shim-"));
  try {
    const binDir = join(root, "bin");
    const targetDir = join(root, "lib", "node_modules", "npm", "bin");
    const target = join(targetDir, "npm-cli.js");
    const shim = join(binDir, "npm");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, "// original npm entrypoint\n");
    symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", shim);

    replaceRuntimeShim(shim, "#!/bin/sh\nexit 0\n");

    expect(lstatSync(shim).isSymbolicLink()).toBe(false);
    expect(lstatSync(shim).mode & 0o111).not.toBe(0);
    expect(readFileSync(shim, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(readFileSync(target, "utf8")).toBe("// original npm entrypoint\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
