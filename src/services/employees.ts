// ABOUTME: Employees service - wraps the generated seren-agent SDK with desktop shapes.
// ABOUTME: Components and stores never call the generated SDK directly; they go through this module.

import {
  type AgentSpec,
  type AgentSpecUpdate,
  type CloudDeploymentSummary,
  type ManagedAgentDeploymentDetail,
  type ManagedAgentDeploymentRevisionSummary,
  type PrivateModelCatalogEntry,
  serenAgentDeleteManagedDeployment,
  serenAgentDeploy,
  serenAgentGetManagedDeployment,
  serenAgentListDeployments,
  serenAgentListManagedDeploymentRevisions,
  serenAgentPrivateModels,
  serenAgentRollbackManagedDeployment,
  serenAgentStartManagedDeployment,
  serenAgentStopManagedDeployment,
  serenAgentUpdateManagedDeployment,
} from "@/api/seren-agent";
import {
  type CloudDeploymentRunEvent,
  serenCloudDeploymentRuns,
} from "@/api/seren-cloud";
import type {
  EmployeeDetail,
  EmployeePatch,
  EmployeeRevision,
  EmployeeRun,
  EmployeeSummary,
  ModelChoice,
  NewEmployeeInput,
} from "@/lib/employees/types";

function asMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.detail === "string") return obj.detail;
    if (typeof obj.error === "string") return obj.error;
  }
  return fallback;
}

function deriveModelChoice(row: CloudDeploymentSummary): ModelChoice {
  const reason = row.managed_agent?.routing_reason?.toLowerCase();
  if (reason?.includes("private")) return "private";
  return "standard";
}

function summaryFromCloud(row: CloudDeploymentSummary): EmployeeSummary {
  const managed = row.managed_agent;
  return {
    id: row.id,
    slug: row.skill_slug,
    name: row.name,
    mode: row.mode,
    status: row.status,
    modelChoice: deriveModelChoice(row),
    modelPolicy: managed?.model_policy ?? null,
    modelId: row.model_id ?? null,
    cronSchedule: row.cron_schedule ?? null,
    cronTimezone: row.cron_timezone ?? null,
    endpointUrl: row.endpoint_url ?? null,
    activeRevisionId: row.active_revision_id ?? null,
    errorMessage: row.error_message ?? null,
    avatarSeed: row.skill_slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function detailFromManaged(
  managed: ManagedAgentDeploymentDetail,
  base: EmployeeSummary,
): EmployeeDetail {
  return {
    ...base,
    template: managed.template,
    toolPresets: managed.tool_presets,
    approvalPolicy: managed.approval_policy,
    resolvedTools: managed.resolved_tools,
    visibility: managed.visibility,
    prompt: managed.prompt ?? null,
    maxIterations: managed.max_iterations ?? null,
    maxToolCallsPerRun: managed.max_tool_calls_per_run ?? null,
    maxTimeoutSeconds: managed.max_timeout_seconds ?? null,
    maxToolOutputChars: managed.max_tool_output_chars ?? null,
    contextBudgetTokens: managed.context_budget_tokens ?? null,
  };
}

function revisionFromCloud(
  row: ManagedAgentDeploymentRevisionSummary,
): EmployeeRevision {
  return {
    revisionId: row.revision_id,
    version: row.version,
    name: row.name,
    agentSlug: row.agent_slug,
    modelId: row.model_id,
    modelPolicy: row.model_policy,
    template: row.template,
    approvalPolicy: row.approval_policy,
    changeKind: row.change_kind,
    changeSummary: row.change_summary,
    changedFields: row.changed_fields,
    restoredFromRevisionId: row.restored_from_revision_id ?? null,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
  };
}

function runFromCloud(row: CloudDeploymentRunEvent): EmployeeRun {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    status: row.status,
    source: row.source,
    runName: row.run_name ?? null,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    executionTimeMs: row.execution_time_ms,
    statusMessage: row.status_message ?? null,
    stopReason: row.stop_reason ?? null,
    output: row.output ?? null,
  };
}

function specFromInput(input: NewEmployeeInput): AgentSpec {
  return {
    name: input.name,
    agent_slug: input.slug,
    mode: input.mode,
    cron_schedule: input.mode === "cron" ? (input.cronSchedule ?? null) : null,
    cron_timezone: input.mode === "cron" ? (input.cronTimezone ?? "UTC") : null,
    template: input.template ?? "research_monitor",
    tool_presets: input.toolPresets ?? ["live_data"],
    approval_policy: input.approvalPolicy ?? "read_only",
    model_policy: input.modelPolicy ?? "balanced",
    private_output_policy: "control_plane",
    visibility: input.visibility ?? "open",
    workload: {
      compute_backend: "aws_container",
      publisher_only: false,
      execution: {
        type: "llm",
        system_prompt: input.systemPrompt,
        model_id:
          input.modelChoice === "private" ? (input.modelId ?? null) : null,
      },
      limits: input.limits
        ? {
            max_iterations: input.limits.maxIterations,
            max_tool_calls_per_run: input.limits.maxToolCallsPerRun,
            max_timeout_seconds: input.limits.maxTimeoutSeconds,
            max_tool_output_chars: input.limits.maxToolOutputChars,
            context_budget_tokens: input.limits.contextBudgetTokens,
          }
        : undefined,
    },
  };
}

function updateSpecFromPatch(patch: EmployeePatch): AgentSpecUpdate {
  const update: AgentSpecUpdate = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.mode === "cron") {
    update.cron_schedule = patch.cronSchedule ?? null;
    update.cron_timezone = patch.cronTimezone ?? "UTC";
  }
  if (patch.template !== undefined) update.template = patch.template;
  if (patch.toolPresets !== undefined) update.tool_presets = patch.toolPresets;
  if (patch.approvalPolicy !== undefined)
    update.approval_policy = patch.approvalPolicy;
  if (patch.visibility !== undefined) update.visibility = patch.visibility;
  if (patch.modelPolicy !== undefined) update.model_policy = patch.modelPolicy;
  // AgentSpecUpdate.workload replaces the whole WorkloadSpec.
  // Only build it when the caller knows the full system prompt;
  // model-only changes without a prompt would otherwise wipe it.
  if (patch.systemPrompt !== undefined) {
    update.workload = {
      compute_backend: "aws_container",
      publisher_only: false,
      execution: {
        type: "llm",
        system_prompt: patch.systemPrompt,
        model_id:
          patch.modelChoice === "private" ? (patch.modelId ?? null) : null,
      },
      limits: patch.limits
        ? {
            max_iterations: patch.limits.maxIterations,
            max_tool_calls_per_run: patch.limits.maxToolCallsPerRun,
            max_timeout_seconds: patch.limits.maxTimeoutSeconds,
            max_tool_output_chars: patch.limits.maxToolOutputChars,
            context_budget_tokens: patch.limits.contextBudgetTokens,
          }
        : undefined,
    };
  } else if (patch.modelChoice !== undefined || patch.limits !== undefined) {
    throw new Error(
      "Updating modelChoice/limits requires systemPrompt (workload is replaced wholesale)",
    );
  }
  return update;
}

export const employees = {
  async list(): Promise<EmployeeSummary[]> {
    const { data, error } = await serenAgentListDeployments({
      throwOnError: false,
    });
    if (error) {
      throw new Error(`Failed to list employees: ${asMessage(error, "")}`);
    }
    const rows = data?.data ?? [];
    return rows.map(summaryFromCloud);
  },

  async get(id: string): Promise<EmployeeDetail> {
    const [
      { data: listData, error: listError },
      { data: detailData, error: detailError, response: detailResponse },
    ] = await Promise.all([
      serenAgentListDeployments({ throwOnError: false }),
      serenAgentGetManagedDeployment({ path: { id }, throwOnError: false }),
    ]);
    if (listError) {
      throw new Error(`Failed to load employee: ${asMessage(listError, "")}`);
    }
    const summary = (listData?.data ?? []).find((row) => row.id === id);
    if (!summary) {
      throw new Error(`Employee ${id} not found`);
    }
    const base = summaryFromCloud(summary);
    if (detailError || !detailData?.data) {
      const status = detailResponse?.status ?? 0;
      if (status === 403) {
        return {
          ...base,
          template: "research_monitor",
          toolPresets: [],
          approvalPolicy: "read_only",
          resolvedTools: [],
          visibility: "opaque",
          prompt: null,
          maxIterations: null,
          maxToolCallsPerRun: null,
          maxTimeoutSeconds: null,
          maxToolOutputChars: null,
          contextBudgetTokens: null,
        };
      }
      throw new Error(`Failed to load employee: ${asMessage(detailError, "")}`);
    }
    return detailFromManaged(detailData.data, base);
  },

  async deploy(input: NewEmployeeInput): Promise<EmployeeSummary> {
    const { data, error } = await serenAgentDeploy({
      body: specFromInput(input),
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error(`Failed to deploy employee: ${asMessage(error, "")}`);
    }
    return summaryFromCloud(data.data);
  },

  async update(id: string, patch: EmployeePatch): Promise<EmployeeSummary> {
    const { data, error } = await serenAgentUpdateManagedDeployment({
      path: { id },
      body: updateSpecFromPatch(patch),
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error(`Failed to update employee: ${asMessage(error, "")}`);
    }
    return summaryFromCloud(data.data);
  },

  async remove(id: string): Promise<void> {
    const { error } = await serenAgentDeleteManagedDeployment({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error(`Failed to delete employee: ${asMessage(error, "")}`);
    }
  },

  async suspend(id: string): Promise<void> {
    const { error } = await serenAgentStopManagedDeployment({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error(`Failed to suspend employee: ${asMessage(error, "")}`);
    }
  },

  async wake(id: string): Promise<void> {
    const { error } = await serenAgentStartManagedDeployment({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error(`Failed to wake employee: ${asMessage(error, "")}`);
    }
  },

  async listPrivateModels(): Promise<PrivateModelCatalogEntry[]> {
    const { data, error } = await serenAgentPrivateModels({
      throwOnError: false,
    });
    if (error) {
      throw new Error(`Failed to list private models: ${asMessage(error, "")}`);
    }
    return data?.data?.models ?? [];
  },

  async listRevisions(id: string): Promise<EmployeeRevision[]> {
    const { data, error } = await serenAgentListManagedDeploymentRevisions({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to list employee revisions: ${asMessage(error, "")}`,
      );
    }
    const rows = data?.data ?? [];
    return rows.map(revisionFromCloud);
  },

  async listRecentRuns(
    id: string,
    limit = 20,
  ): Promise<{ rows: EmployeeRun[]; hasMore: boolean; total: number }> {
    const { data, error } = await serenCloudDeploymentRuns({
      path: { id },
      query: { limit },
      throwOnError: false,
    });
    if (error) {
      throw new Error(`Failed to list employee runs: ${asMessage(error, "")}`);
    }
    const rows = data?.data ?? [];
    return {
      rows: rows.map(runFromCloud),
      hasMore: data?.pagination?.has_more ?? false,
      total: data?.pagination?.total ?? rows.length,
    };
  },

  async rollback(id: string, revisionId: string): Promise<EmployeeSummary> {
    const { data, error } = await serenAgentRollbackManagedDeployment({
      path: { id },
      body: { revision_id: revisionId },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error(`Failed to roll back employee: ${asMessage(error, "")}`);
    }
    return summaryFromCloud(data.data);
  },
};
