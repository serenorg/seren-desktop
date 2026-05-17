// ABOUTME: Tests for employee runtime tool-audit event presentation.
// ABOUTME: Keeps typed tool-ref metadata visible in streamed run output.

import { describe, expect, it } from "vitest";
import { formatToolAuditEvent } from "@/services/employees-runtime";

describe("formatToolAuditEvent", () => {
  it("includes typed ref, action, lease, status, and latency details", () => {
    expect(
      formatToolAuditEvent({
        id: "call_1",
        tool: "messaging",
        reason: "Tool 'messaging' invoked.",
        toolRefKind: "connector",
        action: "send",
        leaseRef: "lease-send",
        status: "success",
        inputBytes: 24,
        outputBytes: 2,
        latencyMs: 17,
      }),
    ).toBe(
      "messaging: Tool 'messaging' invoked. (connector - action send - lease lease-send - success - in 24B - out 2B - 17ms)",
    );
  });

  it("keeps legacy audit events readable when typed metadata is absent", () => {
    expect(
      formatToolAuditEvent({
        id: "call_1",
        tool: "trade",
        reason: "Needs review",
        toolRefKind: null,
        action: null,
        leaseRef: null,
        status: null,
        inputBytes: null,
        outputBytes: null,
        latencyMs: null,
      }),
    ).toBe("trade: Needs review");
  });

  it("normalizes whitespace so markdown blockquotes stay one audit line", () => {
    expect(
      formatToolAuditEvent({
        id: "call_2",
        tool: "remote\nagent",
        reason: "Queued\nfor approval",
        toolRefKind: "remote_agent",
        action: "delegate\nrun",
        leaseRef: null,
        status: "blocked",
        inputBytes: null,
        outputBytes: null,
        latencyMs: null,
      }),
    ).toBe(
      "remote agent: Queued for approval (remote_agent - action delegate run - blocked)",
    );
  });

  it("keeps markdown control characters readable in plain audit text", () => {
    expect(
      formatToolAuditEvent({
        id: "call_6",
        tool: "`webhook`",
        reason: "> invoked *now*",
        toolRefKind: "remote_http",
        action: "lookup_customer",
        leaseRef: null,
        status: "success",
        inputBytes: null,
        outputBytes: null,
        latencyMs: null,
      }),
    ).toBe(
      "`webhook`: > invoked *now* (remote_http - action lookup_customer - success)",
    );
  });

  it("escapes markdown control characters for blockquote audit text", () => {
    expect(
      formatToolAuditEvent(
        {
          id: "call_6",
          tool: "`webhook`",
          reason: "> invoked *now*",
          toolRefKind: "remote_http",
          action: "lookup_customer",
          leaseRef: null,
          status: "success",
          inputBytes: null,
          outputBytes: null,
          latencyMs: null,
        },
        { escapeMarkdown: true },
      ),
    ).toBe(
      "\\`webhook\\`: \\> invoked \\*now\\* (remote_http - action lookup_customer - success)",
    );
  });

  it("keeps zero-byte and zero-latency audit details", () => {
    expect(
      formatToolAuditEvent({
        id: "call_3",
        tool: "cache",
        reason: "Cache probe",
        toolRefKind: null,
        action: null,
        leaseRef: null,
        status: "success",
        inputBytes: 0,
        outputBytes: 0,
        latencyMs: 0,
      }),
    ).toBe("cache: Cache probe (success - in 0B - out 0B - 0ms)");
  });

  it("keeps remote HTTP audit refs visible", () => {
    expect(
      formatToolAuditEvent({
        id: "call_5",
        tool: "webhook_lookup",
        reason: "Remote endpoint invoked.",
        toolRefKind: "remote_http",
        action: "execute",
        leaseRef: null,
        status: "success",
        inputBytes: null,
        outputBytes: null,
        latencyMs: 42,
      }),
    ).toBe(
      "webhook_lookup: Remote endpoint invoked. (remote_http - action execute - success - 42ms)",
    );
  });

  it("tolerates malformed persisted audit metadata without throwing", () => {
    const event = {
      id: "call_4",
      tool: { name: "connector" },
      reason: null,
      toolRefKind: "connector\n> escaped",
      action: ["send"],
      leaseRef: null,
      status: true,
      inputBytes: Number.NaN,
      outputBytes: -1,
      latencyMs: Number.POSITIVE_INFINITY,
    } as unknown as Parameters<typeof formatToolAuditEvent>[0];

    expect(formatToolAuditEvent(event)).toBe(
      '{"name":"connector"} (connector > escaped - action ["send"] - true)',
    );
  });
});
