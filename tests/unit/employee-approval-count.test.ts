// ABOUTME: Protects approval badges from counting awaiting runs instead of decisions.
// ABOUTME: Covers zero, single, and multi-decision cloud run responses.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/api/seren-cloud", () => ({
  serenCloudPendingApprovals: vi.fn(),
}));

import { countPendingDecisions } from "@/services/employee-approvals";

describe("countPendingDecisions", () => {
  it("sums decisions without treating empty runs as pending items", () => {
    expect(countPendingDecisions([{ pendingCount: 0 }])).toBe(0);
    expect(countPendingDecisions([{ pendingCount: 1 }])).toBe(1);
    expect(
      countPendingDecisions([{ pendingCount: 0 }, { pendingCount: 2 }]),
    ).toBe(2);
  });
});
