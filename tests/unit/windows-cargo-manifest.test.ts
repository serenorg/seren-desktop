// ABOUTME: Guards Windows Rust test harness manifest embedding.
// ABOUTME: Plain cargo test must link Common Controls v6 without wrapper mutation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const tauriDir = join(repoRoot, "src-tauri");

describe("Windows cargo test manifest embedding", () => {
  it("links every MSVC test executable with the checked-in Common Controls v6 manifest", () => {
    const buildScriptPath = join(tauriDir, "build.rs");
    const manifestPath = join(tauriDir, "common-controls-v6.manifest");

    expect(existsSync(buildScriptPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    const buildScript = readFileSync(buildScriptPath, "utf8");
    expect(buildScript).toContain('std::env::var("CARGO_MANIFEST_DIR")');
    expect(buildScript).toContain("cargo:rustc-link-arg=/MANIFEST:EMBED");
    expect(buildScript).toContain(
      "cargo:rustc-link-arg=/MANIFESTINPUT:{manifest}",
    );
    expect(buildScript).not.toContain("rustc-link-arg-tests");
    expect(buildScript).toContain("WindowsAttributes::new_without_app_manifest");
    expect(buildScript).toContain("common-controls-v6.manifest");

    const manifest = readFileSync(manifestPath, "utf8");
    expect(manifest).toContain("Microsoft.Windows.Common-Controls");
    expect(manifest).toContain('version="6.0.0.0"');
    expect(manifest).toContain(
      'supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"',
    );
  });

  it("keeps the Windows wrapper from post-build manifest patching", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "test-windows-cargo.ps1"),
      "utf8",
    );

    expect(script).toContain("Remove-AppLocalApiSetForwarders $targetDeps");
    expect(script).not.toContain("Resolve-MtExe");
    expect(script).not.toContain("mt.exe");
    expect(script).not.toContain("-outputresource:");
    expect(script).not.toContain("common-controls-v6.manifest");
  });
});
