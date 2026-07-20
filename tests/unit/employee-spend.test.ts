import type { EmployeeRun } from "@/lib/employees/types";
import {
  formatMicrosUsd,
  parseUsdToMicros,
  sumRunCostMicros,
} from "@/lib/employees/spend";
import { describe, expect, it } from "vitest";

function run(inferenceCostAtomic: number, computeCostAtomic: number): EmployeeRun {
  return {
    id: "run",
    deploymentId: "deployment",
    status: "completed",
    source: "ui",
    runName: null,
    startedAt: "2026-07-20T00:00:00Z",
    completedAt: null,
    executionTimeMs: 1,
    statusMessage: null,
    stopReason: null,
    output: null,
    inferenceCostAtomic,
    computeCostAtomic,
  };
}

describe("employee spend", () => {
  it("parses decimal USD strings as integer micro-dollars", () => {
    expect(parseUsdToMicros("0.000311")).toBe(311);
    expect(parseUsdToMicros("0")).toBe(0);
    expect(parseUsdToMicros("1.5")).toBe(1_500_000);
  });

  it("sums inference and compute atomics across runs", () => {
    expect(sumRunCostMicros([run(11, 20), run(300, 400)])).toBe(731);
  });

  it("formats micro-dollar totals for operator display", () => {
    expect(formatMicrosUsd(311)).toBe("$0.0003");
    expect(formatMicrosUsd(0)).toBe("$0.00");
    expect(formatMicrosUsd(1_234_567)).toBe("$1.23");
  });
});
