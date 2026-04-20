// ABOUTME: Critical tests for Claude Code reasoning effort → --effort CLI arg mapping.
// ABOUTME: Guards against invalid values reaching the spawn and keeps the dropdown options honest.

import { describe, expect, it } from "vitest";

const effortModulePath = new URL(
  "../../bin/browser-local/effort.mjs",
  import.meta.url,
).href;
const mod = await import(/* @vite-ignore */ effortModulePath);

const {
  CLAUDE_EFFORT_VALUES,
  DEFAULT_CLAUDE_EFFORT,
  normalizeEffort,
  buildEffortArgs,
  buildEffortConfigOption,
} = mod;

describe("normalizeEffort", () => {
  it.each(["low", "medium", "high", "xhigh"] as const)(
    "accepts %s",
    (value) => {
      expect(normalizeEffort(value)).toBe(value);
    },
  );

  it("lowercases + trims valid values", () => {
    expect(normalizeEffort("  HIGH  ")).toBe("high");
  });

  const invalidCases: Array<{ value: unknown; note: string }> = [
    { value: "minimal", note: "rejected to avoid a confusing translation to low" },
    { value: "max", note: "not in seren's selector set" },
    { value: "", note: "empty string" },
    { value: "garbage", note: "unknown" },
    { value: null, note: "non-string" },
    { value: undefined, note: "non-string" },
    { value: 42, note: "non-string" },
  ];
  it.each(invalidCases)("rejects $value ($note)", ({ value }) => {
    expect(normalizeEffort(value as string)).toBeNull();
  });
});

describe("buildEffortArgs", () => {
  it("returns --effort <value> for valid values", () => {
    expect(buildEffortArgs("high")).toEqual(["--effort", "high"]);
  });

  it("returns empty array for invalid values — never leaks a bad --effort to the CLI", () => {
    expect(buildEffortArgs("minimal")).toEqual([]);
    expect(buildEffortArgs("")).toEqual([]);
    expect(buildEffortArgs(null as unknown as string)).toEqual([]);
    expect(buildEffortArgs(undefined as unknown as string)).toEqual([]);
  });
});

describe("buildEffortConfigOption", () => {
  it("exposes exactly the four values seren supports for Claude Code", () => {
    const opt = buildEffortConfigOption("medium");
    expect(opt.options.map((o: { value: string }) => o.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("falls back to the default when currentValue is invalid", () => {
    expect(buildEffortConfigOption("minimal").currentValue).toBe(
      DEFAULT_CLAUDE_EFFORT,
    );
  });

  it("has id 'reasoning_effort' and type 'select' so AgentEffortSelector picks it up", () => {
    const opt = buildEffortConfigOption("medium");
    expect(opt.id).toBe("reasoning_effort");
    expect(opt.type).toBe("select");
  });

  it("default matches the setting default", () => {
    expect(DEFAULT_CLAUDE_EFFORT).toBe("medium");
  });

  it("value set matches what the CLI accepts (lock against drift)", () => {
    expect(CLAUDE_EFFORT_VALUES).toEqual(["low", "medium", "high", "xhigh"]);
  });
});
