// ABOUTME: Frontend service wrapper for the Tauri Keys secret-broker commands.
// ABOUTME: Falls back to safe demo metadata in browser-only tests; never returns raw secrets.

import {
  createDemoAuditEvents,
  createDemoKeyBindings,
  createDemoMigrationProposals,
  type KeyApprovalPolicy,
  type SecretAccessSession,
  type SecretAuditEvent,
  type SkillEnvMigrationProposal,
  type SkillSecretBinding,
  type SkillSecretEnvRequest,
  type SkillSecretEnvResponse,
} from "@/lib/keys/secret-broker";
import { isTauriRuntime } from "@/lib/tauri-bridge";

export interface UpsertSkillSecretBindingRequest {
  serviceId: string;
  serviceName: string;
  skillId: string;
  skillName: string;
  secretValues: Record<string, string>;
  approvalPolicy: KeyApprovalPolicy;
}

async function invokeTauri<T>(
  command: string,
  params?: Record<string, unknown>,
): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("Tauri runtime is not available");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, params);
}

export async function listSkillSecretBindings(): Promise<SkillSecretBinding[]> {
  if (!isTauriRuntime()) return createDemoKeyBindings();
  return invokeTauri<SkillSecretBinding[]>("list_skill_secret_bindings");
}

export async function scanSkillEnvMigrations(): Promise<
  SkillEnvMigrationProposal[]
> {
  if (!isTauriRuntime()) return createDemoMigrationProposals();
  return invokeTauri<SkillEnvMigrationProposal[]>("scan_skill_env_migrations");
}

export async function listSecretAccessAudit(): Promise<SecretAuditEvent[]> {
  if (!isTauriRuntime()) return createDemoAuditEvents();
  return invokeTauri<SecretAuditEvent[]>("list_secret_access_audit");
}

export async function upsertSkillSecretBinding(
  request: UpsertSkillSecretBindingRequest,
): Promise<SkillSecretBinding> {
  return invokeTauri<SkillSecretBinding>("upsert_skill_secret_binding", {
    request,
  });
}

export async function requestSkillSecretEnv(
  request: SkillSecretEnvRequest,
): Promise<SkillSecretEnvResponse> {
  return invokeTauri<SkillSecretEnvResponse>("request_skill_secret_env", {
    request,
  });
}

export async function deleteSkillSecretBinding(
  bindingId: string,
): Promise<void> {
  await invokeTauri<void>("delete_skill_secret_binding", { bindingId });
}

export async function grantSkillSecretSession(
  bindingId: string,
  durationMinutes: number,
  capUsd: number,
): Promise<SecretAccessSession> {
  return invokeTauri<SecretAccessSession>("grant_skill_secret_session", {
    bindingId,
    durationMinutes,
    capUsd,
  });
}

export async function endSkillSecretSession(sessionId: string): Promise<void> {
  await invokeTauri<void>("end_skill_secret_session", { sessionId });
}
