// ABOUTME: Tests InboxList grouping and decision-gate logic without a DOM renderer.
// ABOUTME: Mirrors the load-bearing visibility contract: groups by kind, hides actions on terminal states.

import { describe, expect, it } from "vitest";
import {
  entryAllowsDecision,
  groupInboxEntries,
} from "@/components/inbox/grouping";
import type {
  ApprovalDecisionState,
  ApprovalInboxBlockedEgressEntry,
  ApprovalInboxEntry,
  ApprovalInboxToolCallEntry,
} from "@/services/approval-inbox";

function toolCall(
  overrides: Partial<ApprovalInboxToolCallEntry> = {},
): ApprovalInboxToolCallEntry {
  return {
    kind: "tool_call",
    entry_id: "tool:run-1:call-1",
    deployment_id: "dep-1",
    run_id: "run-1",
    tool_call_id: "call-1",
    tool_ref: "seren_publisher_request",
    created_at: "2026-05-13T12:00:00Z",
    decision_state: "pending",
    ...overrides,
  };
}

function blockedEgress(
  overrides: Partial<ApprovalInboxBlockedEgressEntry> = {},
): ApprovalInboxBlockedEgressEntry {
  return {
    kind: "blocked_egress",
    entry_id: "egress:row-1",
    deployment_id: "dep-1",
    run_id: null,
    request_id: "req-1",
    host: "api.example.com",
    port: 443,
    method: "POST",
    path: "/v1/things",
    created_at: "2026-05-13T12:00:00Z",
    decision_state: "pending",
    ...overrides,
  };
}

describe("groupInboxEntries", () => {
  it("splits ToolCall and BlockedEgress entries into separate buckets", () => {
    const entries: ApprovalInboxEntry[] = [
      toolCall(),
      blockedEgress(),
      toolCall({ entry_id: "tool:run-2:call-2", tool_call_id: "call-2" }),
    ];

    const grouped = groupInboxEntries(entries);

    expect(grouped.toolCalls).toHaveLength(2);
    expect(grouped.blockedEgress).toHaveLength(1);
    expect(grouped.other).toHaveLength(0);
    expect(grouped.toolCalls[0].kind).toBe("tool_call");
    expect(grouped.blockedEgress[0].kind).toBe("blocked_egress");
  });

  it("places Other entries in the other bucket", () => {
    const entries: ApprovalInboxEntry[] = [
      {
        kind: "other",
        entry_id: "future:abc",
        deployment_id: "dep-1",
        created_at: "2026-05-13T12:00:00Z",
        decision_state: "pending",
        subkind: "data_export",
      },
    ];

    const grouped = groupInboxEntries(entries);

    expect(grouped.toolCalls).toHaveLength(0);
    expect(grouped.blockedEgress).toHaveLength(0);
    expect(grouped.other).toHaveLength(1);
  });

  it("preserves insertion order within each group", () => {
    const first = toolCall({
      entry_id: "tool:run-1:call-1",
      tool_call_id: "call-1",
    });
    const second = toolCall({
      entry_id: "tool:run-2:call-2",
      tool_call_id: "call-2",
    });

    const grouped = groupInboxEntries([first, blockedEgress(), second]);

    expect(grouped.toolCalls.map((e) => e.tool_call_id)).toEqual([
      "call-1",
      "call-2",
    ]);
  });
});

describe("entryAllowsDecision", () => {
  it("returns true only when the entry is pending", () => {
    expect(entryAllowsDecision(toolCall({ decision_state: "pending" }))).toBe(
      true,
    );
    for (const state of [
      "approved",
      "denied",
      "expired",
    ] satisfies ApprovalDecisionState[]) {
      expect(
        entryAllowsDecision(toolCall({ decision_state: state })),
      ).toBe(false);
    }
  });

  it("applies to BlockedEgress entries with the same rule", () => {
    expect(
      entryAllowsDecision(blockedEgress({ decision_state: "pending" })),
    ).toBe(true);
    expect(
      entryAllowsDecision(blockedEgress({ decision_state: "approved" })),
    ).toBe(false);
  });
});
