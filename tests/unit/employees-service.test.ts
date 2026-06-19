// ABOUTME: Tests desktop employee service request shaping.
// ABOUTME: Guards generated seren-agent SDK payloads for managed employee updates.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentBundle,
  type AgentToolRef,
  type CloudDeploymentSummary,
  type ManagedAgentDeploymentDetail,
  serenAgentDeploy,
  serenAgentGetManagedDeployment,
  serenAgentListDeployments,
  serenAgentPatchManagedDeploymentFiles,
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

  it("sends typed tool refs on deploy and update", async () => {
    const toolRefs: AgentToolRef[] = [
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
            use_budget: 3,
          },
        ],
      },
    ];
    vi.mocked(serenAgentDeploy).mockResolvedValueOnce({
      data: { data: cloudSummary() },
      error: undefined,
    } as never);
    vi.mocked(serenAgentUpdateManagedDeployment).mockResolvedValueOnce({
      data: { data: cloudSummary() },
      error: undefined,
    } as never);

    await employees.deploy({
      name: "Atlas",
      slug: "atlas",
      mode: "always_on",
      instructions: [{ kind: "skill", path: "SKILL.md", content: "Run." }],
      modelChoice: "standard",
      toolRefs,
    });
    await employees.update("dep_1", { toolRefs });

    expect(serenAgentDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          tool_refs: toolRefs,
        }),
        throwOnError: false,
      }),
    );
    expect(serenAgentUpdateManagedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          tool_refs: toolRefs,
        }),
        path: { id: "dep_1" },
        throwOnError: false,
      }),
    );
  });

  it("omits empty tool refs on deploy and uses the clear flag on update", async () => {
    vi.mocked(serenAgentDeploy).mockResolvedValueOnce({
      data: { data: cloudSummary() },
      error: undefined,
    } as never);
    vi.mocked(serenAgentUpdateManagedDeployment).mockResolvedValueOnce({
      data: { data: cloudSummary() },
      error: undefined,
    } as never);

    await employees.deploy({
      name: "Atlas",
      slug: "atlas",
      mode: "always_on",
      instructions: [{ kind: "skill", path: "SKILL.md", content: "Run." }],
      modelChoice: "standard",
      toolRefs: [],
    });
    await employees.update("dep_1", { toolRefs: [] });

    const deployBody = vi.mocked(serenAgentDeploy).mock.calls[0]?.[0].body;
    expect(deployBody).not.toHaveProperty("tool_refs");
    expect(serenAgentUpdateManagedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          clear_tool_refs: true,
        }),
        path: { id: "dep_1" },
        throwOnError: false,
      }),
    );
    const updateBody = vi.mocked(serenAgentUpdateManagedDeployment).mock
      .calls[0]?.[0].body;
    expect(updateBody).not.toHaveProperty("tool_refs");
  });

  it("sends typed memory policy on deploy and update", async () => {
    const memoryPolicy = {
      semantic_memory: {
        enabled: true,
        read_policy: "always_on" as const,
        write_policy: "on_observation" as const,
        store: "seren_managed" as const,
        retention_days: 90,
      },
      compaction: {
        token_threshold: 120000,
        overlap_tokens: 1500,
        event_retention_count: 24,
      },
      transcript_retention_days: 30,
    };
    vi.mocked(serenAgentDeploy).mockResolvedValueOnce({
      data: { data: cloudSummary() },
      error: undefined,
    } as never);
    vi.mocked(serenAgentUpdateManagedDeployment).mockResolvedValueOnce({
      data: { data: cloudSummary() },
      error: undefined,
    } as never);

    await employees.deploy({
      name: "Atlas",
      slug: "atlas",
      mode: "always_on",
      instructions: [{ kind: "skill", path: "SKILL.md", content: "Run." }],
      modelChoice: "standard",
      memoryPolicy,
    });
    await employees.update("dep_1", { memoryPolicy });

    expect(serenAgentDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          memory_policy: memoryPolicy,
        }),
        throwOnError: false,
      }),
    );
    expect(serenAgentUpdateManagedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          memory_policy: memoryPolicy,
        }),
        path: { id: "dep_1" },
        throwOnError: false,
      }),
    );
  });

  it("patches managed deployment files through the narrow files endpoint", async () => {
    vi.mocked(serenAgentPatchManagedDeploymentFiles).mockResolvedValueOnce({
      data: { data: cloudSummary() },
      error: undefined,
    } as never);

    await employees.patchFiles("dep_1", {
      upsert_instructions: [
        { kind: "skill", path: "SKILL.md", content: "Updated." },
      ],
      remove_assets: ["old.json"],
    });

    expect(serenAgentPatchManagedDeploymentFiles).toHaveBeenCalledWith({
      path: { id: "dep_1" },
      body: {
        upsert_instructions: [
          { kind: "skill", path: "SKILL.md", content: "Updated." },
        ],
        remove_assets: ["old.json"],
      },
      throwOnError: false,
    });
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
      runtime_adapter: "seren_agent",
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
