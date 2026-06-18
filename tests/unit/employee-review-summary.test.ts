import { describe, expect, it } from "vitest";
import type { AgentToolRef } from "@/api/seren-agent";
import { buildEmployeePolicyReviewSummary } from "@/lib/employees/review-summary";

describe("buildEmployeePolicyReviewSummary", () => {
  it("summarizes create-time defaults without typed policy refs", () => {
    const summary = buildEmployeePolicyReviewSummary({
      approvalPolicy: "read_only",
      toolPresets: ["live_data"],
    });

    expect(summary.runtimePolicy).toEqual(["Default managed runtime policy"]);
    expect(summary.memoryPolicy).toEqual(["Long-term memory disabled"]);
    expect(summary.toolAccess).toEqual([
      "Presets: Live data",
      "No typed tool refs declared",
    ]);
    expect(summary.toolRefDetails).toEqual(["No typed tool refs declared"]);
    expect(summary.approvalRules).toContain("Read-only by default");
  });

  it("summarizes an enabled Seren-managed semantic memory policy", () => {
    const summary = buildEmployeePolicyReviewSummary({
      approvalPolicy: "read_only",
      toolPresets: [],
      memoryPolicy: {
        semantic_memory: {
          enabled: true,
          read_policy: "always_on",
          write_policy: "on_observation",
          store: "org_default",
          retention_days: 90,
        },
        transcript_retention_days: null,
        compaction: null,
      },
    });

    expect(summary.memoryPolicy).toEqual([
      "Semantic memory enabled; always injected; automatic writes; retention 90d",
    ]);
  });

  it("surfaces runtime policy, typed tool details, and approval gates", () => {
    const summary = buildEmployeePolicyReviewSummary({
      approvalPolicy: "allow_mutations",
      toolPresets: ["publisher_actions", "database"],
      runtimePolicy: {
        version: 1,
        network: {
          default: "deny",
          blocked_request_inbox: true,
          egress_rules: [
            {
              host: "api.example.com",
              port: 443,
              protocol: "rest",
              methods: ["GET"],
            },
          ],
        },
        resources: {
          max_runtime_seconds: 300,
          max_tool_calls: 8,
        },
      },
      guardrails: [
        {
          name: "secrets",
          target: "output",
          human_inbox: true,
          validator: { kind: "regex", pattern: "secret" },
        },
      ],
      toolRefs: [
        {
          kind: "connector",
          connector_ref: "gmail:primary",
          capability: "messaging",
          scopes: ["read", "send"],
          require_approval: true,
          permitted_actions: [
            {
              action: "send",
              capability: { kind: "specific", actions: ["email"] },
            },
          ],
        },
        {
          kind: "publisher",
          publisher_slug: "seren-web",
          operation_id: "fetch",
        },
        {
          kind: "mcp",
          server_ref: "github",
          tool_name: "create_issue",
          require_approval: true,
          permitted_actions: [
            {
              action: "write",
              capability: { kind: "specific", actions: ["issues.create"] },
            },
          ],
        },
        {
          kind: "remote_agent",
          origin: "https://agents.example.com",
          transport: "https",
          auth_mode: "bearer",
          timeout_ms: 30000,
          require_approval: true,
          permitted_actions: [
            {
              action: "delegate",
              capability: { kind: "specific", actions: ["triage"] },
            },
          ],
        },
        {
          kind: "remote_http",
          name: "webhook_lookup",
          endpoint: "https://api.example.com/tools/lookup",
          method: "post",
          auth_mode: "api_key",
          timeout_ms: 5000,
          require_approval: true,
          permitted_actions: [
            {
              action: "execute",
              capability: { kind: "all" },
              use_budget: 3,
            },
          ],
        },
        {
          kind: "preset_group",
          preset: "live_data",
        },
      ],
    });

    expect(summary.runtimePolicy).toContain("Schema v1");
    expect(summary.runtimePolicy).toContain(
      "Network default deny; 1 egress rule; blocked egress inbox on",
    );
    expect(summary.runtimePolicy).toContain("runtime cap 300s, tool cap 8");
    expect(summary.toolAccess[0]).toBe("Presets: Publisher actions, Database");
    expect(summary.toolAccess[1]).toContain("Connector gmail:primary");
    expect(summary.toolRefDetails).toEqual([
      "Connector gmail:primary (messaging); scopes: read, send; send: email; requires approval",
      "Publisher seren-web/fetch; no per-action leases",
      "MCP github/create_issue; write: issues.create; requires approval",
      "Remote agent https://agents.example.com; delegate: triage; requires approval",
      "Remote HTTP POST webhook_lookup; endpoint api.example.com; execute: all; requires approval",
      "Preset Live data; no per-action leases",
    ]);
    expect(summary.approvalRules).toEqual([
      "Mutation-capable tools allowed",
      "4 typed tools require approval",
      "Blocked egress requests route to approval inbox",
      "1 guardrail can route to inbox",
    ]);
  });

  it("summarizes remote HTTP endpoint origin without exposing path or query", () => {
    const summary = buildEmployeePolicyReviewSummary({
      approvalPolicy: "read_only",
      toolPresets: [],
      toolRefs: [
        {
          kind: "remote_http",
          name: "customer_lookup",
          endpoint:
            "https://api.example.com/internal/customer/search?token=secret",
          method: "get",
          auth_mode: "bearer",
        },
      ],
    });

    expect(summary.toolAccess[1]).toBe(
      "Typed refs: Remote HTTP GET customer_lookup",
    );
    expect(summary.toolRefDetails).toEqual([
      "Remote HTTP GET customer_lookup; endpoint api.example.com; no per-action leases",
    ]);
  });

  it("summarizes future unknown tool-ref kinds with a fallback label", () => {
    const summary = buildEmployeePolicyReviewSummary({
      approvalPolicy: "read_only",
      toolPresets: [],
      toolRefs: [
        {
          kind: "future_tool",
        } as unknown as AgentToolRef,
      ],
    });

    expect(summary.toolAccess[1]).toBe("Typed refs: Unknown tool ref future_tool");
    expect(summary.toolRefDetails).toEqual([
      "Unknown tool ref future_tool; no per-action leases",
    ]);
  });
});
