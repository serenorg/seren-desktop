// ABOUTME: Guards the shell approve-for-task predicate selection: single blocked
// ABOUTME: program by default, full toolchain only when explicitly opted in.

import { describe, expect, it } from "vitest";
import { shellLeasePredicates } from "@/components/shell/shellLease";

const TOOLCHAIN = [
  { program: "cargo" },
  { program: "pnpm" },
  { program: "npm" },
  { program: "node" },
  { program: "git" },
];

describe("shellLeasePredicates", () => {
  it("grants only the blocked program when the toolchain opt-in is off", () => {
    const predicates = shellLeasePredicates("cargo", false, TOOLCHAIN);
    expect(predicates.commandRules).toEqual([{ program: "cargo" }]);
  });

  it("grants the whole toolchain when opted in for a toolchain program", () => {
    const predicates = shellLeasePredicates("cargo", true, TOOLCHAIN);
    expect(predicates.commandRules).toEqual(TOOLCHAIN);
  });

  it("never broadens beyond the single program for a non-toolchain command", () => {
    const predicates = shellLeasePredicates("rm", true, TOOLCHAIN);
    expect(predicates.commandRules).toEqual([{ program: "rm" }]);
  });

  it("falls back to the single program when the toolchain failed to load", () => {
    const predicates = shellLeasePredicates("cargo", true, []);
    expect(predicates.commandRules).toEqual([{ program: "cargo" }]);
  });
});
