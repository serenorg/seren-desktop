// ABOUTME: Guards the "Approve for this task" money-bounding conversion — a set
// ABOUTME: spend cap becomes a micro ceiling; a blank cap leaves no monetary allowance.

import { describe, expect, it } from "vitest";
import { leaseBudgetsFromInputs } from "@/components/approvals/leaseBudgets";

describe("leaseBudgetsFromInputs", () => {
  it("threads a set spend cap through as unpinned micros", () => {
    const budgets = leaseBudgetsFromInputs(100, "0.05");
    expect(budgets.maxCalls).toBe(100);
    expect(budgets.maxSpendMicros).toBe(50_000);
    // Asset unpinned so any charged asset counts against the ceiling.
    expect(budgets.asset).toBeNull();
  });

  it("leaves no monetary allowance when the spend cap is blank", () => {
    const budgets = leaseBudgetsFromInputs(100, "");
    expect(budgets.maxCalls).toBe(100);
    expect(budgets.maxSpendMicros).toBeNull();
  });

  it("treats a zero or negative cap as no allowance", () => {
    expect(leaseBudgetsFromInputs(50, "0").maxSpendMicros).toBeNull();
    expect(leaseBudgetsFromInputs(50, "-1").maxSpendMicros).toBeNull();
  });

  it("floors the call count to at least one whole call", () => {
    expect(leaseBudgetsFromInputs(0, "").maxCalls).toBe(1);
    expect(leaseBudgetsFromInputs(3.9, "").maxCalls).toBe(3);
  });

  it("rounds fractional micros to the nearest integer", () => {
    // 0.0000005 USDC * 1_000_000 = 0.5 micros -> rounds to 1.
    expect(leaseBudgetsFromInputs(10, "0.0000005").maxSpendMicros).toBe(1);
  });
});
