// ABOUTME: Guards Tauri plugin npm/Cargo version parity.
// ABOUTME: tauri build aborts when a plugin's JS and Rust sides drift across major/minor.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

/** tauri compares the JS and Rust sides on major/minor only; patch may differ. */
function majorMinor(version: string): string {
  const [major, minor] = version.split(".");
  return `${major}.${minor}`;
}

/** Resolved versions of the root importer's `@tauri-apps/plugin-*` dependencies. */
function npmPluginVersions(): Map<string, string> {
  const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const versions = new Map<string, string>();
  const entry =
    /^ {6}'@tauri-apps\/plugin-([a-z-]+)':\n {8}specifier: .*\n {8}version: (\d+\.\d+\.\d+)/gm;
  for (const [, name, version] of lock.matchAll(entry)) {
    versions.set(name, version);
  }
  return versions;
}

/** Locked versions of the `tauri-plugin-*` crates. */
function cratePluginVersions(): Map<string, string> {
  const lock = readFileSync(join(repoRoot, "src-tauri", "Cargo.lock"), "utf8");
  const versions = new Map<string, string>();
  const entry =
    /^name = "tauri-plugin-([a-z-]+)"\nversion = "(\d+\.\d+\.\d+)"/gm;
  for (const [, name, version] of lock.matchAll(entry)) {
    versions.set(name, version);
  }
  return versions;
}

describe("Tauri plugin npm/Cargo version parity", () => {
  it("keeps every paired plugin on the same major/minor across both ecosystems", () => {
    const npm = npmPluginVersions();
    const crates = cratePluginVersions();

    // Sanity: the parsers must actually see the manifests, or this test would
    // pass vacuously while the drift it guards against ships.
    expect(npm.size).toBeGreaterThan(0);
    expect(crates.size).toBeGreaterThan(0);

    const drifted = [...npm]
      .filter(([name]) => crates.has(name))
      .filter(
        ([name, version]) =>
          majorMinor(version) !== majorMinor(crates.get(name) as string),
      )
      .map(
        ([name, version]) =>
          `@tauri-apps/plugin-${name}@${version} vs tauri-plugin-${name}@${crates.get(name)}`,
      );

    expect(drifted).toEqual([]);
  });

  it("pairs at least one plugin across both ecosystems", () => {
    const npm = npmPluginVersions();
    const crates = cratePluginVersions();
    const paired = [...npm.keys()].filter((name) => crates.has(name));

    expect(paired.length).toBeGreaterThan(0);
  });
});
