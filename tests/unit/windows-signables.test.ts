// ABOUTME: Tests for cross-platform Windows signable-file discovery used by the release signer.
// ABOUTME: Real temp-filesystem trees (no mocks) covering extension filtering, recursion, dedupe, exclusion, and missing roots.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectSignables } from "../../scripts/windows-signables";

let root: string;

function touch(rel: string): string {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, "x");
  return full;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "signables-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectSignables", () => {
  it("selects only PE-signable extensions and ignores the rest", () => {
    const exe = touch("node.exe");
    const dll = touch("lib/libssl.dll");
    const node = touch("native/addon.node");
    const pyd = touch("py/_ssl.pyd");
    touch("readme.txt");
    touch("data/config.json");
    touch("LICENSE");

    const got = collectSignables([root]);

    expect(got).toEqual([dll, node, pyd, exe].sort());
  });

  it("recurses into nested directories", () => {
    const deep = touch("a/b/c/d/deep.dll");
    expect(collectSignables([root])).toEqual([deep]);
  });

  it("matches extensions case-insensitively", () => {
    const a = touch("A.DLL");
    const b = touch("B.Exe");
    expect(collectSignables([root]).sort()).toEqual([a, b].sort());
  });

  it("dedupes a file reachable through overlapping roots", () => {
    const dll = touch("sub/x.dll");
    const got = collectSignables([root, path.join(root, "sub")]);
    expect(got).toEqual([dll]);
  });

  it("skips a missing root without throwing and still scans valid ones", () => {
    const dll = touch("real.dll");
    const missing = path.join(root, "does-not-exist");
    expect(() => collectSignables([missing, root])).not.toThrow();
    expect(collectSignables([missing, root])).toEqual([dll]);
  });

  it("applies exclusion patterns against POSIX-normalized paths", () => {
    const keep = touch("bin/node.exe");
    touch("git/mingw64/bin/libgmp-10.dll");
    const got = collectSignables([root], { exclude: [/\/mingw64\//] });
    expect(got).toEqual([keep]);
  });

  it("does not follow symlinked directories (avoids recursion loops)", () => {
    const real = touch("real/x.dll");
    // Symlink that points back at the tree root would loop a naive walker.
    symlinkSync(root, path.join(root, "real", "loop"), "dir");
    const got = collectSignables([root]);
    expect(got).toEqual([real]);
  });

  it("returns a sorted, deterministic list", () => {
    touch("z.dll");
    touch("a.dll");
    touch("m.exe");
    const got = collectSignables([root]);
    expect(got).toEqual([...got].sort());
  });
});
