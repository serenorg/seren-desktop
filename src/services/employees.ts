// ABOUTME: Employees service - wraps the generated seren-agent SDK with desktop shapes.
// ABOUTME: Components and stores never call the generated SDK directly; they go through this module.

import {
  type AgentBundle,
  type AgentBundlePatch,
  type AgentCapabilityPolicy,
  type AgentSpec,
  type AgentSpecUpdate,
  type AgentToolRef,
  type CloudDeploymentSummary,
  type ManagedAgentDeploymentDetail,
  type ManagedAgentDeploymentRevisionSummary,
  type ManagedAgentToolGroupEntry,
  type PrivateModelCatalogEntry,
  serenAgentDeleteManagedDeployment,
  serenAgentDeploy,
  serenAgentGetManagedDeployment,
  serenAgentListDeployments,
  serenAgentListDeploymentToolGroups,
  serenAgentListManagedDeploymentRevisions,
  serenAgentPatchManagedDeploymentFiles,
  serenAgentPrivateModels,
  serenAgentRollbackManagedDeployment,
  serenAgentStartManagedDeployment,
  serenAgentStopManagedDeployment,
  serenAgentUpdateManagedDeployment,
} from "@/api/seren-agent";
import {
  type CloudDeploymentRunArtifact,
  type CloudDeploymentRunEvent,
  type CloudRunPendingApproval,
  type CloudRunPendingApprovalsResponse,
  serenCloudDeploymentRun,
  serenCloudDeploymentRunArtifacts,
  serenCloudDeploymentRunPendingApprovals,
  serenCloudDeploymentRuns,
  serenCloudRun,
} from "@/api/seren-cloud";
import { formatApiError } from "@/lib/api-errors";
import type {
  EmployeeDetail,
  EmployeePatch,
  EmployeeRevision,
  EmployeeRun,
  EmployeeRunArtifact,
  EmployeeRunDetail,
  EmployeeRunPendingApproval,
  EmployeeRunPendingApprovals,
  EmployeeRunResumeRequest,
  EmployeeSummary,
  ModelChoice,
  NewEmployeeInput,
} from "@/lib/employees/types";

function bundleFromInstructions(
  instructions: AgentBundle["instructions"],
): AgentBundle {
  return { instructions, assets: [] };
}

function nonEmptyToolRefs(
  refs: readonly AgentToolRef[] | undefined,
): AgentToolRef[] | undefined {
  return refs && refs.length > 0 ? [...refs] : undefined;
}

function hasSerenSecretCredentialRefs(
  refs: NewEmployeeInput["credentials"] | undefined,
): boolean {
  return (
    refs?.some((ref) => ref.ref_uri.startsWith("seren-secrets://")) ?? false
  );
}

function requireSecretResolutionDelegation(
  credentials: NewEmployeeInput["credentials"] | undefined,
  delegation: string | null | undefined,
) {
  if (hasSerenSecretCredentialRefs(credentials) && !delegation) {
    throw new Error(
      "Seren Secrets credential refs require a user-signed secret resolution delegation.",
    );
  }
}

function defaultEmployeeCapabilityPolicy(): AgentCapabilityPolicy {
  return {
    tool_error_recovery: {
      enabled: true,
      max_attempts: 3,
      global_limit: 12,
      backoff: {
        kind: "exponential",
        base_delay_ms: 100,
        max_delay_ms: 2_000,
      },
      allow_tools: [],
      deny_tools: [],
    },
    browser: { enabled: false, profile: "minimal" },
    audio: {
      enabled: false,
      speech_to_text: false,
      text_to_speech: false,
      voice_activity_detection: false,
    },
    realtime_sessions: {
      enabled: false,
      provider: "open_ai",
      voice_activity_detection: true,
      input_transcription: true,
      persist_transcripts: true,
      store_to_memory: true,
    },
  };
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
    bundle: managed.bundle,
    instructions: managed.bundle.instructions ?? [],
    maxIterations: managed.max_iterations ?? null,
    maxToolCallsPerRun: managed.max_tool_calls_per_run ?? null,
    maxTimeoutSeconds: managed.max_timeout_seconds ?? null,
    maxToolOutputChars: managed.max_tool_output_chars ?? null,
    contextBudgetTokens: managed.context_budget_tokens ?? null,
    conditions: managed.conditions ?? [],
    runtimePolicy: managed.runtime_policy ?? null,
    guardrails: managed.guardrails ?? [],
    memoryPolicy: managed.memory_policy ?? null,
    capabilityPolicy: managed.capability_policy ?? null,
    agentIdentityId: managed.agent_identity_id ?? null,
    credentials: managed.credentials ?? [],
    toolRefs: managed.tool_refs ?? [],
    evalGate: managed.eval_gate ?? null,
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

function runDetailFromCloud(row: CloudDeploymentRunEvent): EmployeeRunDetail {
  return {
    ...runFromCloud(row),
    computeBackend: row.compute_backend,
    billedDurationMs: row.billed_duration_ms,
    inferenceInputTokens: row.inference_input_tokens,
    inferenceOutputTokens: row.inference_output_tokens,
    inferenceCostUsd: row.inference_cost_usd,
    computeCostUsd: row.compute_cost_usd,
    invocationPayload: row.invocation_payload,
    outputEvents: row.output_events,
    sessionId: row.session_id ?? null,
    conversationId: row.conversation_id ?? null,
  };
}

function pendingApprovalFromCloud(
  row: CloudRunPendingApproval,
): EmployeeRunPendingApproval {
  return {
    id: row.id,
    tool: row.tool,
    reason: row.reason ?? null,
    args: row.args,
    functionCallId: row.function_call_id ?? null,
  };
}

function pendingApprovalsFromCloud(
  row: CloudRunPendingApprovalsResponse,
): EmployeeRunPendingApprovals {
  return {
    runId: row.run_id,
    status: row.status,
    checkpointId: row.checkpoint_id ?? null,
    approvals: (row.pending_approvals ?? []).map(pendingApprovalFromCloud),
  };
}

function artifactFromCloud(
  row: CloudDeploymentRunArtifact,
): EmployeeRunArtifact {
  return {
    id: row.id,
    artifactType: row.artifact_type,
    title: row.title ?? null,
    url: row.url ?? null,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

function specFromInput(input: NewEmployeeInput): AgentSpec {
  const bundle = input.bundle ?? bundleFromInstructions(input.instructions);
  const toolRefs = nonEmptyToolRefs(input.toolRefs);
  requireSecretResolutionDelegation(
    input.credentials,
    input.secretResolutionDelegation,
  );
  return {
    name: input.name,
    agent_slug: input.slug,
    mode: input.mode,
    cron_schedule: input.mode === "cron" ? (input.cronSchedule ?? null) : null,
    cron_timezone: input.mode === "cron" ? (input.cronTimezone ?? "UTC") : null,
    template: input.template ?? "research_monitor",
    tool_presets: input.toolPresets ?? ["live_data"],
    ...(toolRefs ? { tool_refs: toolRefs } : {}),
    ...(input.credentials !== undefined
      ? { credentials: input.credentials }
      : {}),
    ...(input.secretResolutionDelegation !== undefined
      ? { secret_resolution_delegation: input.secretResolutionDelegation }
      : {}),
    ...(input.memoryPolicy !== undefined
      ? { memory_policy: input.memoryPolicy }
      : {}),
    capability_policy:
      input.capabilityPolicy === undefined
        ? defaultEmployeeCapabilityPolicy()
        : input.capabilityPolicy,
    approval_policy: input.approvalPolicy ?? "read_only",
    model_policy: input.modelPolicy ?? "balanced",
    private_output_policy: "control_plane",
    visibility: input.visibility ?? "open",
    workload: {
      compute_backend: "aws_container",
      publisher_only: false,
      execution: {
        type: "llm",
        bundle,
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
  requireSecretResolutionDelegation(
    patch.credentials,
    patch.secretResolutionDelegation,
  );
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.mode === "cron") {
    update.cron_schedule = patch.cronSchedule ?? null;
    update.cron_timezone = patch.cronTimezone ?? "UTC";
  }
  if (patch.template !== undefined) update.template = patch.template;
  if (patch.toolPresets !== undefined) update.tool_presets = patch.toolPresets;
  if (patch.toolRefs !== undefined) {
    if (patch.toolRefs.length === 0) {
      update.clear_tool_refs = true;
    } else {
      update.tool_refs = patch.toolRefs;
    }
  }
  if (patch.credentials !== undefined) {
    if (patch.credentials.length === 0) {
      update.clear_credentials = true;
      update.clear_secret_resolution_delegation = true;
    } else {
      update.credentials = patch.credentials;
    }
  }
  if (patch.secretResolutionDelegation !== undefined) {
    if (patch.secretResolutionDelegation === null) {
      update.clear_secret_resolution_delegation = true;
    } else {
      update.secret_resolution_delegation = patch.secretResolutionDelegation;
    }
  }
  if (patch.approvalPolicy !== undefined)
    update.approval_policy = patch.approvalPolicy;
  if (patch.visibility !== undefined) update.visibility = patch.visibility;
  if (patch.modelPolicy !== undefined) update.model_policy = patch.modelPolicy;
  if (patch.memoryPolicy !== undefined) {
    if (patch.memoryPolicy === null) {
      update.clear_memory_policy = true;
    } else {
      update.memory_policy = patch.memoryPolicy;
    }
  }
  if (patch.capabilityPolicy !== undefined) {
    if (patch.capabilityPolicy === null) {
      update.clear_capability_policy = true;
    } else {
      update.capability_policy = patch.capabilityPolicy;
    }
  }
  // AgentSpecUpdate.workload replaces the whole WorkloadSpec.
  // Only build it when the caller knows the full bundle; model-only changes
  // without bundle content would otherwise wipe it.
  if (patch.bundle !== undefined || patch.instructions !== undefined) {
    const bundle =
      patch.bundle ?? bundleFromInstructions(patch.instructions ?? []);
    update.workload = {
      compute_backend: "aws_container",
      publisher_only: false,
      execution: {
        type: "llm",
        bundle,
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
      "Updating modelChoice/limits requires bundle content (workload is replaced wholesale)",
    );
  }
  return update;
}

export const employees = {
  async list(): Promise<EmployeeSummary[]> {
    const { data, error, response } = await serenAgentListDeployments({
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to list employees: ${formatApiError(error, response, "")}`,
      );
    }
    const rows = data?.data ?? [];
    return rows.map(summaryFromCloud);
  },

  async get(id: string): Promise<EmployeeDetail> {
    const [
      { data: listData, error: listError, response: listResponse },
      { data: detailData, error: detailError, response: detailResponse },
    ] = await Promise.all([
      serenAgentListDeployments({ throwOnError: false }),
      serenAgentGetManagedDeployment({ path: { id }, throwOnError: false }),
    ]);
    if (listError) {
      throw new Error(
        `Failed to load employee: ${formatApiError(listError, listResponse, "")}`,
      );
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
          bundle: { instructions: [], assets: [] },
          instructions: [],
          maxIterations: null,
          maxToolCallsPerRun: null,
          maxTimeoutSeconds: null,
          maxToolOutputChars: null,
          contextBudgetTokens: null,
          conditions: [],
          runtimePolicy: null,
          guardrails: [],
          memoryPolicy: null,
          capabilityPolicy: null,
          agentIdentityId: null,
          credentials: [],
          toolRefs: [],
          evalGate: null,
        };
      }
      throw new Error(
        `Failed to load employee: ${formatApiError(detailError, detailResponse, "")}`,
      );
    }
    return detailFromManaged(detailData.data, base);
  },

  async deploy(input: NewEmployeeInput): Promise<EmployeeSummary> {
    const { data, error, response } = await serenAgentDeploy({
      body: specFromInput(input),
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error(
        `Failed to deploy employee: ${formatApiError(error, response, "")}`,
      );
    }
    return summaryFromCloud(data.data);
  },

  async update(id: string, patch: EmployeePatch): Promise<EmployeeSummary> {
    const { data, error, response } = await serenAgentUpdateManagedDeployment({
      path: { id },
      body: updateSpecFromPatch(patch),
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error(
        `Failed to update employee: ${formatApiError(error, response, "")}`,
      );
    }
    return summaryFromCloud(data.data);
  },

  async patchFiles(
    id: string,
    patch: AgentBundlePatch,
  ): Promise<EmployeeSummary> {
    const { data, error, response } =
      await serenAgentPatchManagedDeploymentFiles({
        path: { id },
        body: patch,
        throwOnError: false,
      });
    if (error || !data?.data) {
      throw new Error(
        `Failed to update employee files: ${formatApiError(error, response, "")}`,
      );
    }
    return summaryFromCloud(data.data);
  },

  async remove(id: string): Promise<void> {
    const { error, response } = await serenAgentDeleteManagedDeployment({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to delete employee: ${formatApiError(error, response, "")}`,
      );
    }
  },

  async suspend(id: string): Promise<void> {
    const { error, response } = await serenAgentStopManagedDeployment({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to suspend employee: ${formatApiError(error, response, "")}`,
      );
    }
  },

  async wake(id: string): Promise<void> {
    const { error, response } = await serenAgentStartManagedDeployment({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to wake employee: ${formatApiError(error, response, "")}`,
      );
    }
  },

  async listPrivateModels(): Promise<PrivateModelCatalogEntry[]> {
    const { data, error, response } = await serenAgentPrivateModels({
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to list private models: ${formatApiError(error, response, "")}`,
      );
    }
    return data?.data?.models ?? [];
  },

  async listToolGroups(id: string): Promise<ManagedAgentToolGroupEntry[]> {
    const { data, error, response } = await serenAgentListDeploymentToolGroups({
      path: { id },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to list employee tool groups: ${formatApiError(error, response, "")}`,
      );
    }
    return data?.data?.tool_groups ?? [];
  },

  async listRevisions(id: string): Promise<EmployeeRevision[]> {
    const { data, error, response } =
      await serenAgentListManagedDeploymentRevisions({
        path: { id },
        throwOnError: false,
      });
    if (error) {
      throw new Error(
        `Failed to list employee revisions: ${formatApiError(error, response, "")}`,
      );
    }
    const rows = data?.data ?? [];
    return rows.map(revisionFromCloud);
  },

  async getRun(
    deploymentId: string,
    runId: string,
  ): Promise<EmployeeRunDetail> {
    const { data, error, response } = await serenCloudDeploymentRun({
      path: { id: deploymentId, run_id: runId },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error(
        `Failed to load run: ${formatApiError(error, response, "")}`,
      );
    }
    return runDetailFromCloud(data.data);
  },

  async listRunArtifacts(
    deploymentId: string,
    runId: string,
  ): Promise<EmployeeRunArtifact[]> {
    const { data, error, response } = await serenCloudDeploymentRunArtifacts({
      path: { id: deploymentId, run_id: runId },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to list run artifacts: ${formatApiError(error, response, "")}`,
      );
    }
    const rows = data?.data ?? [];
    return rows.map(artifactFromCloud);
  },

  async listRecentRuns(
    id: string,
    limit = 20,
  ): Promise<{ rows: EmployeeRun[]; hasMore: boolean; total: number }> {
    const { data, error, response } = await serenCloudDeploymentRuns({
      path: { id },
      query: { limit },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to list employee runs: ${formatApiError(error, response, "")}`,
      );
    }
    const rows = data?.data ?? [];
    return {
      rows: rows.map(runFromCloud),
      hasMore: data?.pagination?.has_more ?? false,
      total: data?.pagination?.total ?? rows.length,
    };
  },

  async listPendingApprovals(
    deploymentId: string,
    runId: string,
  ): Promise<EmployeeRunPendingApprovals> {
    const { data, error, response } =
      await serenCloudDeploymentRunPendingApprovals({
        path: { id: deploymentId, run_id: runId },
        throwOnError: false,
      });
    if (error || !data?.data) {
      throw new Error(
        `Failed to load pending approvals: ${formatApiError(error, response, "")}`,
      );
    }
    return pendingApprovalsFromCloud(data.data);
  },

  async resumeRun(
    deploymentId: string,
    request: EmployeeRunResumeRequest,
  ): Promise<{ runId: string | null; status: string }> {
    const { data, error, response } = await serenCloudRun({
      path: { id: deploymentId },
      body: {
        resume_checkpoint_id: request.checkpointId,
        approval_decisions: request.decisions.map((d) => ({
          id: d.id,
          decision: d.decision,
        })),
        message: request.message,
      },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error(
        `Failed to resume run: ${formatApiError(error, response, "")}`,
      );
    }
    return {
      runId: data.data.run_id ?? null,
      status: data.data.status,
    };
  },

  async rollback(id: string, revisionId: string): Promise<EmployeeSummary> {
    const { data, error, response } = await serenAgentRollbackManagedDeployment(
      {
        path: { id },
        body: { revision_id: revisionId },
        throwOnError: false,
      },
    );
    if (error || !data?.data) {
      throw new Error(
        `Failed to roll back employee: ${formatApiError(error, response, "")}`,
      );
    }
    return summaryFromCloud(data.data);
  },
};
