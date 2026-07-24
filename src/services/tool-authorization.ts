// ABOUTME: Renderer bridge for the host-owned tool-authorization gate: capability leases,
// ABOUTME: suspended approval continuations, task execution state, and the audit trail.

import { invoke } from "@tauri-apps/api/core";

/** Mirrors `CommandRule` in `src-tauri/src/capability_lease.rs`. */
export interface CommandRule {
  program: string;
}

/** Mirrors `PublisherRule` in `src-tauri/src/capability_lease.rs`. */
export interface PublisherRule {
  publisherSlug: string;
  allowHighRisk?: boolean;
  target?: string | null;
}

/** Mirrors `Exclusion` in `src-tauri/src/capability_lease.rs`. */
export interface LeaseExclusion {
  route?: string;
  publisherSlug?: string;
  toolName?: string;
  host?: string;
  program?: string;
}

/** Mirrors `LeasePredicates` in `src-tauri/src/capability_lease.rs`. */
export interface LeasePredicates {
  commandRules?: CommandRule[];
  networkHosts?: string[];
  publisherOps?: PublisherRule[];
  exclusions?: LeaseExclusion[];
}

/** Mirrors `LeaseBudgets` in `src-tauri/src/capability_lease.rs`. */
export interface LeaseBudgets {
  maxCalls?: number | null;
  callsUsed?: number;
  maxSpendMicros?: number | null;
  spendUsedMicros?: number;
  asset?: string | null;
}

/** Mirrors `CapabilityLease` in `src-tauri/src/capability_lease.rs`. */
export interface CapabilityLease {
  id: string;
  conversationId: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  predicates: LeasePredicates;
  budgets: LeaseBudgets;
}

/** Task states from `src-tauri/src/orchestrator/types.rs` (`TaskExecutionState`). */
export type TaskExecutionState =
  | "running"
  | "running_with_blocked_actions"
  | "waiting_for_approval"
  | "approval_denied"
  | "approval_expired"
  | "action_skipped";

export type ContinuationState =
  | "pending"
  | "approved"
  | "denied"
  | "skipped"
  | "expired";

/** Mirrors `RequestedCapability` in `src-tauri/src/approval_continuation.rs`. */
export interface RequestedCapability {
  route: string;
  publisherSlug: string;
  toolName: string;
  operationClass: string;
  description: string;
  isDestructive: boolean;
  command?: string;
  host?: string;
  target?: string;
}

/** Mirrors `ContinuationView` — a redacted continuation (never a resume token). */
export interface ContinuationView {
  approvalId: string;
  taskId: string;
  blockedScope: "linear" | "branch";
  state: ContinuationState;
  taskState: TaskExecutionState;
  requestedCapability: RequestedCapability;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

/** Mirrors `ResolutionSummary` in `src-tauri/src/approval_continuation.rs`. */
export interface ResolutionSummary {
  unresolved: number;
  approved: number;
  denied: number;
  skipped: number;
  expired: number;
}

/** Mirrors `AuditEntry` in `src-tauri/src/authorization_audit.rs`. */
export interface AuthorizationAuditEntry {
  id: number;
  conversationId: string;
  event: string;
  subjectId?: string;
  route?: string;
  publisherSlug?: string;
  toolName?: string;
  detail?: string;
  createdAt: string;
}

/** Mirrors `ProposedBundle` in `src-tauri/src/capability_lease.rs`. */
export interface ProposedBundle {
  label: string;
  durationSecs: number;
  predicates: LeasePredicates;
  budgets: LeaseBudgets;
}

/** Every capability lease bound to a conversation, newest first. */
export async function listCapabilityLeases(
  conversationId: string,
): Promise<CapabilityLease[]> {
  return invoke<CapabilityLease[]>("list_capability_leases", {
    conversationId,
  });
}

/**
 * Revoke a lease immediately; the gate stops honoring it on the next
 * evaluation. Idempotent — resolves to whether this call changed anything.
 */
export async function revokeCapabilityLease(leaseId: string): Promise<boolean> {
  return invoke<boolean>("revoke_capability_lease", { leaseId });
}

/**
 * Persist a user-approved lease. Only ever invoked from approval UI a human
 * drives — model output cannot mint or widen authority.
 */
export async function grantCapabilityLease(
  conversationId: string,
  label: string,
  durationSecs: number,
  predicates: LeasePredicates,
  budgets: LeaseBudgets,
): Promise<CapabilityLease> {
  return invoke<CapabilityLease>("grant_capability_lease", {
    conversationId,
    label,
    durationSecs,
    predicates,
    budgets,
  });
}

/** Every continuation for a conversation (pending and settled), for inspection. */
export async function listApprovalContinuations(
  conversationId: string,
): Promise<ContinuationView[]> {
  return invoke<ContinuationView[]>("list_approval_continuations", {
    conversationId,
  });
}

/** Every live pending approval across all conversations — the global inbox. */
export async function listPendingApprovals(): Promise<ContinuationView[]> {
  return invoke<ContinuationView[]>("list_pending_approvals");
}

/** The live task-execution state for a conversation. */
export async function taskExecutionState(
  conversationId: string,
): Promise<TaskExecutionState> {
  return invoke<TaskExecutionState>("task_execution_state", {
    conversationId,
  });
}

/** Outcome counts backing completion integrity and the final disclosure. */
export async function approvalResolutionSummary(
  conversationId: string,
): Promise<ResolutionSummary> {
  return invoke<ResolutionSummary>("approval_resolution_summary", {
    conversationId,
  });
}

/** The newest audit rows for a conversation (credential-safe by construction). */
export async function listAuthorizationAudit(
  conversationId: string,
  limit?: number,
): Promise<AuthorizationAuditEntry[]> {
  return invoke<AuthorizationAuditEntry[]>("list_authorization_audit", {
    conversationId,
    limit,
  });
}
