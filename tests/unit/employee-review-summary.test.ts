import { describe, expect, it } from "vitest";
import { buildEmployeePolicyReviewSummary } from "@/lib/employees/review-summary";

describe("buildEmployeePolicyReviewSummary", () => {
  it("summarizes create-time defaults without typed policy refs", () => {
    const summary = buildEmployeePolicyReviewSummary({
      approvalPolicy: "read_only",
      toolPresets: ["live_data"],
    });

    expect(summary.runtimePolicy).toEqual(["Default managed runtime policy"]);
    expect(summary.toolAccess).toEqual([
      "Presets: Live data",
      "No typed tool refs declared",
    ]);
    expect(summary.toolRefDetails).toEqual(["No typed tool refs declared"]);
    expect(summary.approvalRules).toContain("Read-only by default");
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
      "Preset Live data; no per-action leases",
    ]);
    expect(summary.approvalRules).toEqual([
      "Mutation-capable tools allowed",
      "3 typed tools require approval",
      "Blocked egress requests route to approval inbox",
      "1 guardrail can route to inbox",
    ]);
  });
});
