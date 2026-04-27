// ABOUTME: Source-level invariant for #1684 — every console.error in src/ must
// ABOUTME: pass an Error (or stack-bearing object) so the support pipeline can capture it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve("src");
const STRING_ONLY_ERROR = /console\.error\("[^"]*"\)\s*;/g;

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      // src/api/generated/ is regenerated from openapi/ — out of scope.
      if (entry === "generated") continue;
      yield* walkSourceFiles(full);
      continue;
    }
    if (/\.tsx?$/.test(entry)) yield full;
  }
}

function findStringOnlyErrors(): string[] {
  const offenders: string[] = [];
  for (const file of walkSourceFiles(SRC)) {
    const source = readFileSync(file, "utf-8");
    const lines = source.split("\n");
    lines.forEach((line, idx) => {
      if (STRING_ONLY_ERROR.test(line)) {
        offenders.push(`${file}:${idx + 1}: ${line.trim()}`);
      }
      STRING_ONLY_ERROR.lastIndex = 0;
    });
  }
  return offenders;
}

describe("#1684 — console.error invariant", () => {
  it("no console.error in src/ uses a single string-literal arg (it would bypass the support pipeline gate)", () => {
    // Gate: src/lib/support/hook.ts looks for an Error (or stack-bearing
    // object) among the args before forwarding. A string-only console.error
    // logs to the dev console but never lands in serenorg/seren-core. Wrap
    // as `console.error(new Error("..."))` so the pipeline can capture it,
    // or use `console.warn` if it's genuinely non-reportable.
    const offenders = findStringOnlyErrors();
    expect(offenders).toEqual([]);
  });
});
