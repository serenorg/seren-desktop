// ABOUTME: Guards the reproducible pip-launcher bootstrap so unchanged inputs stop re-signing pip*.exe (#2926).
// ABOUTME: Unit-level only — the byte-identical-launcher proof is a Windows release-time observation.

import { describe, expect, it } from "vitest";
import {
  assertGetPipIntegrity,
  assertLaunchersReproducible,
  buildPipBootstrapCommand,
  PIP_SOURCE_DATE_EPOCH,
  PIP_VERSION,
  pipBootstrapEnv,
} from "../../build/win32/prepare-python-runtime";

describe("reproducible pip bootstrap (#2926)", () => {
  it("forces a fixed SOURCE_DATE_EPOCH so distlib launcher ZIPs are deterministic", () => {
    const env = pipBootstrapEnv({ PATH: "/usr/bin" }, PIP_SOURCE_DATE_EPOCH);
    // The launcher timestamp non-determinism is the whole bug: the subprocess
    // MUST carry the fixed epoch, and the base env must survive.
    expect(env.SOURCE_DATE_EPOCH).toBe(String(PIP_SOURCE_DATE_EPOCH));
    expect(env.PATH).toBe("/usr/bin");
  });

  it("pins the exact pip version in the bootstrap command", () => {
    const cmd = buildPipBootstrapCommand("C:/py/python.exe", "C:/py/get-pip.py", PIP_VERSION);
    expect(cmd).toContain(`"pip==${PIP_VERSION}"`);
    expect(cmd).toContain("--disable-pip-version-check");
  });

  it("uses explicit, valid pinned config", () => {
    expect(PIP_VERSION).toMatch(/^\d+\.\d+(\.\d+)?$/);
    expect(Number.isInteger(PIP_SOURCE_DATE_EPOCH)).toBe(true);
    expect(PIP_SOURCE_DATE_EPOCH).toBeGreaterThan(0);
  });

  it("fails closed when a pinned get-pip digest does not match", () => {
    expect(() => assertGetPipIntegrity("aaaa", "bbbb")).toThrow(/integrity check failed/i);
  });

  it("passes a matching digest (case-insensitive) and is record-only when unpinned", () => {
    expect(() => assertGetPipIntegrity("ABCDEF", "abcdef")).not.toThrow();
    expect(() => assertGetPipIntegrity("anything", "")).not.toThrow();
  });

  it("returns the shared hash when all pip launchers are reproducible", () => {
    const shared = assertLaunchersReproducible([
      { name: "pip.exe", sha256: "DEAD" },
      { name: "pip3.exe", sha256: "dead" },
      { name: "pip3.12.exe", sha256: "dead" },
    ]);
    expect(shared).toBe("dead");
  });

  it("fails closed when the pip launchers diverge (#2926 §5)", () => {
    expect(() =>
      assertLaunchersReproducible([
        { name: "pip.exe", sha256: "aaa" },
        { name: "pip3.exe", sha256: "bbb" },
        { name: "pip3.12.exe", sha256: "aaa" },
      ]),
    ).toThrow(/not reproducible/i);
  });
});
