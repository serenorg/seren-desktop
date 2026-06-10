// ABOUTME: Tests the flatten/restore CLI pair that batch-signs the Windows embedded-runtime payload (#2235).
// ABOUTME: Pins collision-safe flattening, manifest round-trip, and the fail-loud gap when the signer drops a file.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FLATTEN = join(process.cwd(), "scripts/flatten-windows-signables.mjs");
const RESTORE = join(process.cwd(), "scripts/restore-windows-signables.mjs");

function run(script: string, args: string[]) {
  return spawnSync("node", [script, ...args], { encoding: "utf8" });
}

function write(path: string, content = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

interface ManifestEntry {
  flat: string;
  original: string;
}

describe("flatten-windows-signables", () => {
  let tmp: string;
  let staging: string;
  let manifestPath: string;

  function readManifest(): ManifestEntry[] {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "winsign-"));
    staging = join(tmp, "staging");
    manifestPath = join(tmp, "manifest.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("collects only Authenticode-signable extensions, ignoring data files", () => {
    const root = join(tmp, "embedded-runtime");
    write(join(root, "node", "node.exe"));
    write(join(root, "git", "cmd", "git.exe"));
    write(join(root, "git", "mingw64", "bin", "libcurl.dll"));
    write(join(root, "python", "python313.dll"));
    write(join(root, "python", "_ssl.pyd"));
    write(join(root, "node", "npm.cmd")); // not signable
    write(join(root, "embedded-runtime.json")); // not signable
    write(join(root, "git", "README.txt")); // not signable

    const result = run(FLATTEN, [staging, manifestPath, root]);

    expect(result.status).toBe(0);
    const manifest = readManifest();
    const originals = manifest.map((e) => e.original).sort();
    expect(originals).toEqual(
      [
        join(root, "git", "cmd", "git.exe"),
        join(root, "git", "mingw64", "bin", "libcurl.dll"),
        join(root, "node", "node.exe"),
        join(root, "python", "_ssl.pyd"),
        join(root, "python", "python313.dll"),
      ].sort(),
    );
    // The signed dir holds ONLY binaries — the manifest lives outside it so the
    // SSL.com batch signer never tries to sign a non-PE file.
    const staged = readdirSync(staging);
    expect(staged.length).toBe(5);
    expect(staged).not.toContain("manifest.json");
  });

  it("gives colliding basenames distinct flat names and keeps them separable", () => {
    const root = join(tmp, "runtime");
    write(join(root, "mingw64", "bin", "zlib1.dll"), "A");
    write(join(root, "usr", "bin", "zlib1.dll"), "B");

    const result = run(FLATTEN, [staging, manifestPath, root]);

    expect(result.status).toBe(0);
    const manifest = readManifest();
    expect(manifest.length).toBe(2);
    // Flat names are unique even though basenames collide.
    const flats = manifest.map((e) => e.flat);
    expect(new Set(flats).size).toBe(2);
    // Each flat file preserves its source bytes, so signing then restore is faithful.
    for (const entry of manifest) {
      const expected = readFileSync(entry.original, "utf8");
      expect(readFileSync(join(staging, entry.flat), "utf8")).toBe(expected);
    }
  });

  it("flat names use signer-supported extensions while preserving original manifest paths", () => {
    const root = join(tmp, "runtime");
    write(join(root, "node.exe"));
    write(join(root, "a.dll"));
    write(join(root, "b.node"));
    write(join(root, "_ssl.pyd"));

    run(FLATTEN, [staging, manifestPath, root]);

    const stagedByOriginal = new Map(
      readManifest().map((entry) => [entry.original.slice(root.length + 1), entry.flat]),
    );

    expect(stagedByOriginal.get("node.exe")?.endsWith(".exe")).toBe(true);
    expect(stagedByOriginal.get("a.dll")?.endsWith(".dll")).toBe(true);
    expect(stagedByOriginal.get("b.node")?.endsWith(".dll")).toBe(true);
    expect(stagedByOriginal.get("_ssl.pyd")?.endsWith(".dll")).toBe(true);
  });

  it("merges multiple roots into one staging dir", () => {
    const r1 = join(tmp, "embedded-runtime");
    const r2 = join(tmp, "mcp-servers");
    write(join(r1, "node.exe"));
    write(join(r2, "playwright", "chromium.node"));

    const result = run(FLATTEN, [staging, manifestPath, r1, r2]);

    expect(result.status).toBe(0);
    expect(readManifest().length).toBe(2);
  });

  it("skips missing roots without failing (arch-specific dirs may be absent)", () => {
    const present = join(tmp, "present");
    write(join(present, "node.exe"));
    const absent = join(tmp, "does-not-exist");

    const result = run(FLATTEN, [staging, manifestPath, present, absent]);

    expect(result.status).toBe(0);
    expect(readManifest().length).toBe(1);
  });

  it("writes an empty manifest and exits 0 when no signables are found", () => {
    const root = join(tmp, "runtime");
    write(join(root, "readme.txt"));

    const result = run(FLATTEN, [staging, manifestPath, root]);

    expect(result.status).toBe(0);
    expect(readManifest()).toEqual([]);
  });

  it("exits with a usage error when no roots are given", () => {
    const result = run(FLATTEN, [staging, manifestPath]);
    expect(result.status).toBe(2);
  });
});

describe("restore-windows-signables", () => {
  let tmp: string;
  let staging: string;
  let signed: string;
  let manifestPath: string;

  function readManifest(): ManifestEntry[] {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "winrestore-"));
    staging = join(tmp, "staging");
    signed = join(tmp, "signed");
    manifestPath = join(tmp, "manifest.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("copies signed files back over the originals via the manifest", () => {
    const root = join(tmp, "runtime");
    write(join(root, "a", "node.exe"), "unsigned-node");
    write(join(root, "b", "git.exe"), "unsigned-git");

    run(FLATTEN, [staging, manifestPath, root]);
    const manifest = readManifest();

    // Simulate the signer: emit "signed" copies into the signed dir.
    mkdirSync(signed, { recursive: true });
    for (const entry of manifest) {
      writeFileSync(join(signed, entry.flat), `signed:${entry.original}`);
    }

    const result = run(RESTORE, [signed, manifestPath]);

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "a", "node.exe"), "utf8")).toBe(
      `signed:${join(root, "a", "node.exe")}`,
    );
    expect(readFileSync(join(root, "b", "git.exe"), "utf8")).toBe(
      `signed:${join(root, "b", "git.exe")}`,
    );
  });

  it("fails loud and names the gap when the signer dropped a file (#2223 silent-failure shape)", () => {
    const root = join(tmp, "runtime");
    write(join(root, "node.exe"));
    write(join(root, "git.exe"));

    run(FLATTEN, [staging, manifestPath, root]);
    const manifest = readManifest();

    // Signer only produced ONE of the two expected outputs.
    mkdirSync(signed, { recursive: true });
    writeFileSync(join(signed, manifest[0].flat), "signed");

    const result = run(RESTORE, [signed, manifestPath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(manifest[1].flat);
    // Atomic: nothing is restored when the set is incomplete.
    expect(readFileSync(manifest[0].original, "utf8")).toBe("x");
  });

  it("exits cleanly on an empty manifest (signing disabled / nothing to do)", () => {
    mkdirSync(signed, { recursive: true });
    const manifestPath = join(tmp, "manifest.json");
    writeFileSync(manifestPath, "[]");

    const result = run(RESTORE, [signed, manifestPath]);

    expect(result.status).toBe(0);
  });

  it("exits with a usage error when the manifest is missing", () => {
    mkdirSync(signed, { recursive: true });
    const result = run(RESTORE, [signed, join(tmp, "nope.json")]);
    expect(result.status).toBe(2);
  });
});
