// ABOUTME: Tests for the CI guard that catches unresolved NSIS placeholders.
// ABOUTME: Pins the #2230 regression shape — literal ${lowercase_token} leaking into installer UI.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/scan-nsis-placeholders.mjs");

function runScanner(dir: string) {
  return spawnSync("node", [SCRIPT, dir], { encoding: "utf8" });
}

describe("scan-nsis-placeholders", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nsis-scan-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails when an unresolved ${product_name} placeholder appears (#2230)", () => {
    writeFileSync(
      join(tmp, "installer.nsi"),
      [
        "; Generated NSI fragment",
        'MessageBox MB_OK "${product_name} is running! Click OK to kill it"',
        "",
      ].join("\n"),
    );

    const result = runScanner(tmp);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("${product_name}");
    expect(result.stderr).toContain("FAIL");
  });

  it("passes when only uppercase NSIS symbols are present", () => {
    // ${INSTDIR}, ${BUILD_DIR}, ${MUI_PRODUCT} etc. are legitimate NSIS
    // !define expansions. Only lowercase-with-underscores tokens match the
    // bundler-substitution shape we're hunting for.
    writeFileSync(
      join(tmp, "installer.nsi"),
      [
        'OutFile "${BUILD_DIR}\\setup.exe"',
        "InstallDir ${INSTDIR}",
        "!define MUI_PRODUCT ${PRODUCT_NAME}",
      ].join("\n"),
    );

    const result = runScanner(tmp);

    expect(result.status).toBe(0);
  });

  it("ignores commented-out placeholder mentions", () => {
    writeFileSync(
      join(tmp, "installer.nsi"),
      [
        "; This template used to leak ${product_name} into the dialog",
        '!define PRODUCT_NAME "SerenDesktop"',
      ].join("\n"),
    );

    const result = runScanner(tmp);

    expect(result.status).toBe(0);
  });

  it("returns 0 with no .nsi files present", () => {
    writeFileSync(join(tmp, "README.txt"), "not nsi");

    const result = runScanner(tmp);

    expect(result.status).toBe(0);
  });
});
