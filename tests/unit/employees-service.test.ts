// ABOUTME: Tests desktop employee service request shaping.
// ABOUTME: Guards generated seren-agent SDK payloads for managed employee updates.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentBundle,
  type CloudDeploymentSummary,
  type ManagedAgentDeploymentDetail,
  serenAgentGetManagedDeployment,
  serenAgentListDeployments,
  serenAgentUpdateManagedDeployment,
} from "@/api/seren-agent";
import { employees } from "@/services/employees";

vi.mock("@/api/seren-agent", () => ({
  serenAgentDeleteManagedDeployment: vi.fn(),
  serenAgentDeploy: vi.fn(),
  serenAgentGetManagedDeployment: vi.fn(),
  serenAgentListDeployments: vi.fn(),
  serenAgentListManagedDeploymentRevisions: vi.fn(),
  serenAgentPatchManagedDeploymentFiles: vi.fn(),
  serenAgentPrivateModels: vi.fn(),
  serenAgentRollbackManagedDeployment: vi.fn(),
  serenAgentStartManagedDeployment: vi.fn(),
  serenAgentStopManagedDeployment: vi.fn(),
  serenAgentUpdateManagedDeployment: vi.fn(),
}));

vi.mock("@/api/seren-cloud", () => ({
  serenCloudDeploymentRun: vi.fn(),
  serenCloudDeploymentRunArtifacts: vi.fn(),
  serenCloudDeploymentRunPendingApprovals: vi.fn(),
  serenCloudDeploymentRuns: vi.fn(),
  serenCloudRun: vi.fn(),
}));

function cloudSummary(): CloudDeploymentSummary {
  return {
    code_bundle_hash: "hash",
    compute_backend: "aws_container",
    created_at: "2026-01-01T00:00:00Z",
    id: "dep_1",
    managed_agent: {
      allowed_publisher_operations: [],
      approval_policy: "read_only",
      build_target: "python",
      model_policy: "balanced",
      publisher: "seren-agent",
      resolved_tools: [],
      routing_reason: "standard",
      runtime_adapter: "seren-orchestrator",
      target_framework: "seren",
      template: "research_monitor",
      tool_presets: ["live_data"],
    },
    mode: "always_on",
    name: "Atlas",
    orchestration_mode: "llm",
    organization_id: "org_1",
    requirements: {},
    runtime_kind: "python",
    skill_slug: "atlas",
    status: "running",
    updated_at: "2026-01-01T00:00:00Z",
    user_id: "user_1",
    visibility: "open",
  };
}

describe("employees service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the full bundle on update so asset files are preserved", async () => {
    const bundle: AgentBundle = {
      assets: [
        {
          content_base64: "e30=",
          content_type: "application/json",
          path: "schemas/input.json",
          purpose: "schema",
        },
      ],
      instructions: [
        {
          kind: "skill",
          path: "SKILL.md",
          content: "Updated instructions.",
        },
      ],
    };
    vi.mocked(serenAgentUpdateManagedDeployment).mockResolvedValueOnce({
      data: { data: cloudSummary() },
      error: undefined,
    } as never);

    await employees.update("dep_1", {
      bundle,
      instructions: bundle.instructions ?? [],
      modelChoice: "standard",
    });

    expect(serenAgentUpdateManagedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          workload: expect.objectContaining({
            execution: expect.objectContaining({
              bundle,
            }),
          }),
        }),
        path: { id: "dep_1" },
        throwOnError: false,
      }),
    );
  });

  it("maps typed governance fields onto EmployeeDetail when present", async () => {
    const managedDetail: ManagedAgentDeploymentDetail = {
      active_revision_id: "rev_1",
      agent_slug: "atlas",
      allowed_publisher_operations: [],
      approval_policy: "read_only",
      bundle: { instructions: [], assets: [] },
      compute_backend: "aws_container",
      conditions: [
        {
          type: "Ready",
          status: "False",
          reason: "Pending",
          message: null,
        },
      ],
      credentials: [
        {
          name: "openai",
          binding: "env",
          kind: "api_key",
          ref_uri: "control-plane://providers/openai",
        },
      ],
      deployment_id: "dep_1",
      guardrails: [
        {
          name: "no_secrets",
          target: "output",
          validator: { kind: "regex", pattern: "secret" },
        },
      ],
      memory_policy: {
        semantic_memory: { enabled: true },
      },
      mode: "always_on",
      model_config: null,
      model_id: "claude-3",
      model_policy: "balanced",
      name: "Atlas",
      private_output_policy: "control_plane",
      requirements: [],
      resolved_tools: [],
      routing_reason: "standard",
      runtime_adapter: "adk",
      runtime_kind: "python",
      runtime_policy: {
        version: 1,
        network: { default: "deny", egress_rules: [] },
      },
      secret_keys: [],
      status: "running",
      template: "research_monitor",
      tool_presets: ["live_data"],
      tool_refs: [
        {
          kind: "publisher",
          publisher_slug: "seren-web",
          operation_id: "fetch",
        },
      ],
      eval_gate: {
        set_id: "set_eval_1",
        max_age_seconds: 3600,
        block_on_failure: true,
      },
      visibility: "open",
    };

    vi.mocked(serenAgentListDeployments).mockResolvedValueOnce({
      data: { data: [cloudSummary()] },
      error: undefined,
    } as never);
    vi.mocked(serenAgentGetManagedDeployment).mockResolvedValueOnce({
      data: { data: managedDetail },
      error: undefined,
    } as never);

    const detail = await employees.get("dep_1");

    expect(detail.conditions).toHaveLength(1);
    expect(detail.conditions[0]).toMatchObject({
      type: "Ready",
      status: "False",
    });
    expect(detail.runtimePolicy?.network?.default).toBe("deny");
    expect(detail.guardrails).toHaveLength(1);
    expect(detail.memoryPolicy?.semantic_memory?.enabled).toBe(true);
    expect(detail.credentials).toHaveLength(1);
    expect(detail.toolRefs).toHaveLength(1);
    expect(detail.evalGate).toMatchObject({
      set_id: "set_eval_1",
      max_age_seconds: 3600,
      block_on_failure: true,
    });
  });

  it("returns null governance defaults for opaque 403 detail responses", async () => {
    vi.mocked(serenAgentListDeployments).mockResolvedValueOnce({
      data: { data: [cloudSummary()] },
      error: undefined,
    } as never);
    vi.mocked(serenAgentGetManagedDeployment).mockResolvedValueOnce({
      data: undefined,
      error: { detail: "forbidden" },
      response: { status: 403 } as Response,
    } as never);

    const detail = await employees.get("dep_1");

    expect(detail.conditions).toEqual([]);
    expect(detail.runtimePolicy).toBeNull();
    expect(detail.guardrails).toEqual([]);
    expect(detail.memoryPolicy).toBeNull();
    expect(detail.credentials).toEqual([]);
    expect(detail.toolRefs).toEqual([]);
    expect(detail.evalGate).toBeNull();
    expect(detail.visibility).toBe("opaque");
  });
});
