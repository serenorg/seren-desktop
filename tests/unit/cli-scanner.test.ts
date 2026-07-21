// ABOUTME: Critical tests for #1647 — local diff + static-check scanner.
// ABOUTME: Locks the gate behavior; no live npm pack / no network in tests.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/cli-scanner.mjs",
  import.meta.url,
).href;
const {
  buildPackageSnapshot,
  diffSnapshots,
  evaluateFirstBaselinePolicy,
  runStaticChecks,
  verifyTarballIntegrity,
} = await import(/* @vite-ignore */ modulePath);

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "seren-cli-scanner-test-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writePackage(files: Record<string, string>) {
  const pkgDir = path.join(tempRoot, "package");
  mkdirSync(pkgDir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(pkgDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }
  return pkgDir;
}

describe("buildPackageSnapshot", () => {
  it("captures install scripts, declared deps, executables, hosts, files, and hashes", () => {
    const pkgDir = writePackage({
      "package.json": JSON.stringify({
        name: "@test/x",
        version: "1.0.0",
        scripts: { postinstall: "node setup.js", build: "tsc" },
        dependencies: { foo: "1.0.0", bar: "^2.0.0" },
        bin: { x: "bin/x.js" },
      }),
      "bin/x.js": 'fetch("https://api.example.com/v1");',
    });
    const snap = buildPackageSnapshot(pkgDir);
    expect(snap.version).toBe("1.0.0");
    expect(snap.installScripts).toEqual({ postinstall: "node setup.js" });
    expect(snap.declaredDependencies).toEqual(["bar", "foo"]);
    expect(snap.binEntries).toEqual({ x: "bin/x.js" });
    expect(snap.executableFiles).toEqual(["bin/x.js"]);
    expect(snap.networkHosts).toEqual(["api.example.com"]);
    expect(snap.files).toContain("package.json");
    expect(snap.files).toContain("bin/x.js");
    expect(typeof snap.fileHashes["package.json"]).toBe("string");
  });
});

describe("registry integrity and first-baseline gate (#3092)", () => {
  it("accepts only the exact sha512 integrity for the downloaded tarball", () => {
    const tarballPath = path.join(tempRoot, "candidate.tgz");
    writeFileSync(tarballPath, "verified candidate bytes", "utf8");
    const expected = `sha512-${createHash("sha512")
      .update("verified candidate bytes")
      .digest("base64")}`;

    expect(verifyTarballIntegrity(tarballPath, expected)).toBe(true);
    expect(verifyTarballIntegrity(tarballPath, "sha512-AAAAAAAA")).toBe(false);
    expect(verifyTarballIntegrity(tarballPath, "sha1-deadbeef")).toBe(false);
  });

  it("fails a first baseline closed on unapproved scripts, deps, executables, or hosts", () => {
    const policy = {
      installScripts: { postinstall: "node install.cjs" },
      dependencyPatterns: [/^@vendor\/cli-(darwin|linux|win32)-/],
      binEntries: { cli: "bin/cli.js" },
      executableFiles: ["bin/cli.js"],
      hostnameAllowlist: ["vendor.example"],
    };
    const candidate = {
      installScripts: { postinstall: "node install.cjs" },
      declaredDependencies: ["@vendor/cli-darwin-arm64"],
      binEntries: { cli: "bin/cli.js" },
      executableFiles: ["bin/cli.js"],
      networkHosts: ["api.vendor.example"],
    };

    expect(evaluateFirstBaselinePolicy(candidate, policy)).toEqual([]);
    expect(
      evaluateFirstBaselinePolicy(
        { ...candidate, installScripts: { postinstall: "node payload.js" } },
        policy,
      ),
    ).toContain("first_baseline_install_script:postinstall");
    expect(
      evaluateFirstBaselinePolicy(
        { ...candidate, declaredDependencies: ["plain-crypto-js"] },
        policy,
      ),
    ).toContain("first_baseline_dependency:plain-crypto-js");
    expect(
      evaluateFirstBaselinePolicy(
        { ...candidate, executableFiles: ["bin/cli.js", "payload.exe"] },
        policy,
      ),
    ).toContain("first_baseline_executable:payload.exe");
    expect(
      evaluateFirstBaselinePolicy(
        { ...candidate, networkHosts: ["collector.invalid"] },
        policy,
      ),
    ).toContain("first_baseline_host:collector.invalid");
  });
});

describe("diffSnapshots — the axios pattern", () => {
  const baseline = {
    installScripts: {},
    declaredDependencies: ["foo"],
    files: ["package.json", "dist/index.js"],
    fileHashes: { "package.json": "h1", "dist/index.js": "h2" },
  };

  it("flags a newly-introduced postinstall script — exactly the axios attack pattern", () => {
    const candidate = {
      installScripts: { postinstall: "node payload.js" },
      declaredDependencies: ["foo"],
      files: ["package.json", "dist/index.js"],
      fileHashes: { "package.json": "h1-changed", "dist/index.js": "h2" },
    };
    expect(diffSnapshots(baseline, candidate)).toContain(
      "new_install_script:postinstall",
    );
  });

  it("flags a newly-added runtime dependency — Shai-Hulud / axios style dep injection", () => {
    const candidate = {
      installScripts: {},
      declaredDependencies: ["foo", "plain-crypto-js"],
      files: baseline.files,
      fileHashes: baseline.fileHashes,
    };
    expect(diffSnapshots(baseline, candidate)).toContain(
      "new_dependency:plain-crypto-js",
    );
  });

  it("flags a new top-level file or new file in an entry-point directory", () => {
    const candidate = {
      installScripts: {},
      declaredDependencies: ["foo"],
      files: [...baseline.files, "stealth.js", "dist/payload.js"],
      fileHashes: { ...baseline.fileHashes, "stealth.js": "h3", "dist/payload.js": "h4" },
    };
    const flags = diffSnapshots(baseline, candidate);
    expect(flags).toContain("new_file:stealth.js");
    expect(flags).toContain("new_file:dist/payload.js");
  });

  it("does not flag dep removals or non-entry-point new files — those are not the attack pattern", () => {
    const candidate = {
      installScripts: {},
      declaredDependencies: [],
      files: [...baseline.files, "test/extra.spec.js"],
      fileHashes: { ...baseline.fileHashes, "test/extra.spec.js": "h5" },
    };
    const flags = diffSnapshots(baseline, candidate);
    expect(flags).not.toContain("new_dependency:foo");
    expect(flags).not.toContain("new_file:test/extra.spec.js");
  });

  it("returns an empty array for a clean version bump (same scripts, deps, files)", () => {
    expect(diffSnapshots(baseline, baseline)).toEqual([]);
  });
});

describe("runStaticChecks — the chalk/debug pattern", () => {
  it("flags eval(), new Function(), and dynamic require — code-injection markers", () => {
    const pkgDir = writePackage({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "lib/a.js": "module.exports = function() { eval('1+1'); };",
      "lib/b.js": "const f = new Function('return 1');",
      "lib/c.js": "const r = require(name);",
    });
    const flags = runStaticChecks(pkgDir);
    expect(flags.some((f: string) => f.startsWith("eval_call:lib/a.js"))).toBe(true);
    expect(flags.some((f: string) => f.startsWith("new_function:lib/b.js"))).toBe(
      true,
    );
    expect(
      flags.some((f: string) => f.startsWith("dynamic_require:lib/c.js")),
    ).toBe(true);
  });

  it("flags newly-introduced child_process imports — Shai-Hulud bundles often add this", () => {
    const pkgDir = writePackage({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "lib/x.js": 'const cp = require("child_process");',
    });
    // Baseline did not have this file at all.
    const flags = runStaticChecks(pkgDir, { baseline: { fileHashes: {} } });
    expect(
      flags.some((f: string) => f.startsWith("child_process_in_new_file:lib/x.js")),
    ).toBe(true);
  });

  it("flags large base64 literals — payload smuggling marker", () => {
    const big = "A".repeat(3000);
    const pkgDir = writePackage({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "lib/p.js": `module.exports = "${big}";`,
    });
    const flags = runStaticChecks(pkgDir);
    expect(
      flags.some((f: string) => f.startsWith("large_base64_literal:lib/p.js")),
    ).toBe(true);
  });

  it("clean readable JS produces no flags — keeps false-positive rate low", () => {
    const pkgDir = writePackage({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "lib/clean.js": "module.exports = function add(a, b) { return a + b; };",
    });
    expect(runStaticChecks(pkgDir)).toEqual([]);
  });
});
