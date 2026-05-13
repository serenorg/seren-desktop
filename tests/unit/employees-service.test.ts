// ABOUTME: Tests desktop employee service request shaping.
// ABOUTME: Guards generated seren-agent SDK payloads for managed employee updates.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentBundle,
  type CloudDeploymentSummary,
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
});
