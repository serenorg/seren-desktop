// ABOUTME: Desktop-side types for virtual employees (deployed seren-agent workers).
// ABOUTME: Maps the generated SerenAgent SDK shapes onto a flatter desktop model.

import type {
  CloudDeploymentMode,
  CloudDeploymentStatus,
  ManagedAgentApprovalPolicy,
  ManagedAgentModelPolicy,
  ManagedAgentTemplate,
  ManagedAgentToolPreset,
} from "@/api/seren-agent";

export type EmployeeMode = CloudDeploymentMode;
export type EmployeeStatus = CloudDeploymentStatus;
export type EmployeeModelPolicy = ManagedAgentModelPolicy;
export type EmployeeTemplate = ManagedAgentTemplate;
export type EmployeeToolPreset = ManagedAgentToolPreset;
export type EmployeeApprovalPolicy = ManagedAgentApprovalPolicy;

export type ModelChoice = "standard" | "private";

export type EmployeeSummary = {
  id: string;
  slug: string;
  name: string;
  mode: EmployeeMode;
  status: EmployeeStatus;
  modelChoice: ModelChoice;
  modelPolicy: EmployeeModelPolicy | null;
  modelId: string | null;
  cronSchedule: string | null;
  cronTimezone: string | null;
  endpointUrl: string | null;
  activeRevisionId: string | null;
  errorMessage: string | null;
  avatarSeed: string;
  createdAt: string;
  updatedAt: string;
};

export type EmployeeDetail = EmployeeSummary & {
  template: EmployeeTemplate;
  toolPresets: EmployeeToolPreset[];
  approvalPolicy: EmployeeApprovalPolicy;
  resolvedTools: string[];
  visibility: string;
  prompt: string | null;
  maxIterations: number | null;
  maxToolCallsPerRun: number | null;
  maxTimeoutSeconds: number | null;
  maxToolOutputChars: number | null;
  contextBudgetTokens: number | null;
};

export type NewEmployeeInput = {
  name: string;
  slug: string;
  mode: EmployeeMode;
  cronSchedule?: string;
  cronTimezone?: string;
  systemPrompt: string;
  modelChoice: ModelChoice;
  modelPolicy?: EmployeeModelPolicy;
  modelId?: string;
  template?: EmployeeTemplate;
  toolPresets?: EmployeeToolPreset[];
  approvalPolicy?: EmployeeApprovalPolicy;
  visibility?: "open" | "opaque";
  limits?: {
    maxIterations?: number;
    maxToolCallsPerRun?: number;
    maxTimeoutSeconds?: number;
    maxToolOutputChars?: number;
    contextBudgetTokens?: number;
  };
};

export type EmployeePatch = Partial<
  Omit<NewEmployeeInput, "slug" | "modelChoice"> & {
    modelChoice: ModelChoice;
  }
>;

export type EmployeeRevisionChangeKind = "create" | "update" | "rollback";

export type EmployeeRevision = {
  revisionId: string;
  version: number;
  name: string;
  agentSlug: string;
  modelId: string;
  modelPolicy: EmployeeModelPolicy;
  template: EmployeeTemplate;
  approvalPolicy: EmployeeApprovalPolicy;
  changeKind: EmployeeRevisionChangeKind;
  changeSummary: string[];
  changedFields: string[];
  restoredFromRevisionId: string | null;
  createdAt: string;
  createdByUserId: string;
};

export type EmployeeRun = {
  id: string;
  deploymentId: string;
  status: string;
  source: string;
  runName: string | null;
  startedAt: string;
  completedAt: string | null;
  executionTimeMs: number;
  statusMessage: string | null;
  stopReason: string | null;
  output: string | null;
};

export type EmployeeRunDetail = EmployeeRun & {
  computeBackend: string;
  billedDurationMs: number;
  inferenceInputTokens: number;
  inferenceOutputTokens: number;
  inferenceCostUsd: string;
  computeCostUsd: string;
  invocationPayload: unknown;
  outputEvents: unknown;
  sessionId: string | null;
  conversationId: string | null;
};

export type EmployeeRunArtifact = {
  id: string;
  artifactType: string;
  title: string | null;
  url: string | null;
  payload: unknown;
  createdAt: string;
};

export type EmployeeRunPendingApproval = {
  id: string;
  tool: string;
  reason: string | null;
  args: unknown;
  functionCallId: string | null;
};

export type EmployeeRunPendingApprovals = {
  runId: string;
  status: string;
  checkpointId: string | null;
  approvals: EmployeeRunPendingApproval[];
};

export type EmployeeRunApprovalDecision = "approve" | "reject";

export type EmployeeRunResumeRequest = {
  checkpointId: string;
  decisions: { id: string; decision: EmployeeRunApprovalDecision }[];
  message?: string;
};
