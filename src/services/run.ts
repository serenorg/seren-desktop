// ABOUTME: Typed renderer bridge for the durable run-engine commands.
// ABOUTME: This is the only Mission Control module allowed to cross the Tauri IPC boundary.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TaskState =
  | "pending"
  | "ready"
  | "provisioning"
  | "running"
  | "blocked"
  | "verifying"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export type RunStatus =
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
export type LeaseMode =
  | "shared_readonly"
  | "worktree"
  | "scratch"
  | "external_read"
  | "external_write";
export type FindingConfidence = "asserted" | "verified" | "refuted";
export type FindingStatus = "open" | "accepted" | "rejected" | "superseded";
export type EvidenceKind =
  | "command_result"
  | "file_range"
  | "email"
  | "document"
  | "url"
  | "log_excerpt"
  | "publisher_result";
export type ArtifactKind = "diff" | "document" | "email" | "comment";
export type RunEventType =
  | "run_created"
  | "task_added"
  | "dependency_added"
  | "assignment_added"
  | "task_state_changed"
  | "attempt_started"
  | "attempt_finished"
  | "finding_recorded"
  | "evidence_attached"
  | "approval_requested"
  | "run_cancel_requested"
  | "run_finalized"
  | "lease_state_changed"
  | "check_declared"
  | "check_approved"
  | "check_result_recorded"
  | "coverage_gap_recorded"
  | "task_completion_rejected"
  | "finding_status_changed";

export interface Run {
  id: string;
  objective: string;
  root_path: string | null;
  status: RunStatus;
  cancel_requested: boolean;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface Task {
  id: string;
  run_id: string;
  title: string;
  brief: string;
  state: TaskState;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskDependency {
  task_id: string;
  depends_on_task_id: string;
}

export interface AgentAssignment {
  id: string;
  run_id: string;
  agent_type: string;
  model_id: string | null;
  role_label: string | null;
  created_at: number;
}

export interface Attempt {
  id: string;
  task_id: string;
  agent_assignment_id: string | null;
  agent_session_id: string | null;
  attempt_number: number;
  outcome: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface WorkspaceLease {
  id: string;
  run_id: string;
  task_id: string | null;
  mode: LeaseMode;
  root_path: string | null;
  base_revision: string | null;
  state: string;
  created_at: number;
  released_at: number | null;
}

export interface Evidence {
  kind: EvidenceKind;
  reference: string;
  excerpt: string | null;
}

export interface ProposedArtifact {
  kind: ArtifactKind;
  title: string;
  content: string | null;
}

export interface Finding {
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  claim: string;
  confidence: FindingConfidence;
  evidence: Evidence[];
  proposed_artifact: ProposedArtifact | null;
  needs_approval: boolean;
  status: FindingStatus;
  created_at: number;
  updated_at: number;
}

export interface CheckDeclaration {
  name: string;
  command: string;
}

export interface RunCheck {
  id: string;
  run_id: string;
  name: string;
  command: string;
  approved: boolean;
  created_at: number;
}

export interface CheckResult {
  id: string;
  check_id: string;
  task_id: string | null;
  attempt_id: string | null;
  kind: string;
  exit_code: number | null;
  duration_ms: number;
  output_tail: string;
  pre_existing_failure: boolean;
  created_at: number;
}

export interface CoverageGap {
  id: string;
  run_id: string;
  task_id: string | null;
  kind: string;
  subject: string;
  detail: string | null;
  created_at: number;
}

export interface RunEvent {
  id: string;
  run_id: string;
  task_id: string | null;
  attempt_id: string | null;
  agent_id: string | null;
  sequence: number;
  event_type: RunEventType;
  payload: Record<string, unknown>;
  provider_event_id: string | null;
  created_at: number;
}

export interface FindingInput extends Finding {}
export interface CoverageGapInput extends CoverageGap {}

export interface RunSnapshot {
  run: Run;
  tasks: Task[];
  dependencies: TaskDependency[];
  assignments: AgentAssignment[];
  attempts: Attempt[];
  findings: Finding[];
  checks: RunCheck[];
  check_results: CheckResult[];
  coverage_gaps: CoverageGap[];
}

export async function runCreate(
  objective: string,
  rootPath?: string | null,
): Promise<Run> {
  return invoke("run_create", {
    objective,
    root_path: rootPath ?? null,
  }) as Promise<Run>;
}

export async function runAddTask(
  runId: string,
  title: string,
  brief: string,
  dependsOn: string[] = [],
): Promise<Task> {
  return invoke("run_add_task", {
    run_id: runId,
    title,
    brief,
    depends_on: dependsOn,
  }) as Promise<Task>;
}

export async function runAddAgent(
  runId: string,
  agentType: string,
  modelId?: string | null,
  roleLabel?: string | null,
): Promise<AgentAssignment> {
  return invoke("run_add_agent", {
    run_id: runId,
    agent_type: agentType,
    model_id: modelId ?? null,
    role_label: roleLabel ?? null,
  }) as Promise<AgentAssignment>;
}

export async function runCancel(runId: string): Promise<Run> {
  return invoke("run_cancel", { run_id: runId }) as Promise<Run>;
}

export async function runGetState(runId: string): Promise<RunSnapshot> {
  return invoke("run_get_state", { run_id: runId }) as Promise<RunSnapshot>;
}

export async function runListEvents(
  runId: string,
  afterSequence = 0,
): Promise<RunEvent[]> {
  return invoke("run_list_events", {
    run_id: runId,
    after_sequence: afterSequence,
  }) as Promise<RunEvent[]>;
}

export async function runList(): Promise<Run[]> {
  return invoke("run_list") as Promise<Run[]>;
}

export async function runDeclareChecks(
  runId: string,
  checks: CheckDeclaration[],
): Promise<RunCheck[]> {
  return invoke("run_declare_checks", {
    run_id: runId,
    checks,
  }) as Promise<RunCheck[]>;
}

export async function runApproveCheck(checkId: string): Promise<RunCheck> {
  return invoke("run_approve_check", {
    check_id: checkId,
  }) as Promise<RunCheck>;
}

export async function runBaseline(runId: string): Promise<CheckResult[]> {
  return invoke("run_baseline", { run_id: runId }) as Promise<CheckResult[]>;
}

export async function runVerifyTask(
  runId: string,
  taskId: string,
): Promise<CheckResult[]> {
  return invoke("run_verify_task", {
    run_id: runId,
    task_id: taskId,
  }) as Promise<CheckResult[]>;
}

export async function runCompleteTask(
  runId: string,
  taskId: string,
): Promise<string[]> {
  return invoke("run_complete_task", {
    run_id: runId,
    task_id: taskId,
  }) as Promise<string[]>;
}

export async function runRecordFinding(finding: FindingInput): Promise<void> {
  return invoke("run_record_finding", { finding }) as Promise<void>;
}

export async function runAddCoverageGap(gap: CoverageGapInput): Promise<void> {
  return invoke("run_add_coverage_gap", { gap }) as Promise<void>;
}

export async function runUpdateFindingStatus(
  runId: string,
  findingId: string,
  status: Exclude<FindingStatus, "open">,
): Promise<void> {
  return invoke("run_update_finding_status", {
    run_id: runId,
    finding_id: findingId,
    status,
  }) as Promise<void>;
}

export function subscribeRunEvents(
  onEvent: (event: RunEvent) => void,
): Promise<UnlistenFn> {
  return listen<RunEvent>("run://event", (event) => onEvent(event.payload));
}
