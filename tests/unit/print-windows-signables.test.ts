// ABOUTME: Functional test for the print-windows-signables CLI entrypoint, spawned as a subprocess like the release step.
// ABOUTME: Guards the regression where the CLI never executed and emitted an empty signing list (#2284).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cli = path.join(repoRoot, "scripts", "print-windows-signables.ts");

let root: string;

function touch(rel: string): string {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, "x");
  return full;
}

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(tsxBin, [cli, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "print-signables-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("print-windows-signables CLI", () => {
  it("runs as a subprocess and prints the discovered signables, one per line", () => {
    const exe = touch("node.exe");
    const dll = touch("lib/libssl.dll");
    touch("readme.txt");

    const { stdout, status } = runCli([root]);

    expect(status).toBe(0);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    // Only paths, no banner contamination; exactly the two signables.
    expect(lines.sort()).toEqual([dll, exe].sort());
  });

  it("emits nothing (not an error) when no signables exist", () => {
    touch("readme.txt");
    const { stdout, status } = runCli([root]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("exits non-zero when invoked with no roots", () => {
    const { status } = runCli([]);
    expect(status).toBe(2);
  });
});
