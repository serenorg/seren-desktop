// ABOUTME: Frontend service wrapper for Seren Passwords reference bindings.
// ABOUTME: Falls back to safe demo metadata in browser-only tests; never returns plaintext.

import {
  createDemoAuditEvents,
  createDemoKeyBindings,
  createDemoMigrationProposals,
  type KeyApprovalPolicy,
  type SecretAccessSession,
  type SecretAuditEvent,
  type SecretBindingSource,
  type SkillEnvMigrationProposal,
  type SkillSecretBinding,
  type SkillSecretEnvRequest,
  type SkillSecretEnvResponse,
} from "@/lib/keys/secret-broker";
import { isTauriRuntime } from "@/lib/tauri-bridge";

export interface UpsertSkillSecretBindingRequest {
  source: SecretBindingSource;
  serviceId: string;
  serviceName: string;
  skillId: string;
  skillName: string;
  secretValues: Record<string, string>;
  approvalPolicy: KeyApprovalPolicy;
}

export interface PasswordsSecretFieldInput {
  name: string;
  value: string;
}

export interface CreatePasswordsApiCredentialRequest {
  masterPassword: string;
  title: string;
  serviceName: string;
  fields: PasswordsSecretFieldInput[];
}

export interface CreatePasswordsApiCredentialResponse {
  vaultId: string;
  itemId: string;
  references: Record<string, string>;
}

export interface PasswordsVaultSummary {
  vaultId: string;
  name: string;
  writable: boolean;
  itemCount: number;
}

export interface UnlockPasswordsVaultResponse {
  vaults: PasswordsVaultSummary[];
  mcpAgentIdentityId?: string | null;
}

export interface SetupPasswordsVaultResponse {
  recoveryKeyDisplay: string;
  personalVaultId: string;
  vaults: PasswordsVaultSummary[];
  mcpAgentIdentityId?: string | null;
}

export interface PasswordsItemSummary {
  vaultId: string;
  itemId: string;
  title: string;
  itemKind: string;
  favorite: boolean;
  sensitive: boolean;
  reprompt: boolean;
  tags: string[];
  updatedAt: string;
  decryptError: boolean;
}

export interface PasswordsItemDetail {
  vaultId: string;
  itemId: string;
  title: string;
  itemKind: string;
  fields: PasswordsSecretFieldInput[];
  updatedAt: string;
}

export interface SavePasswordsApiCredentialRequest {
  vaultId: string;
  itemId?: string | null;
  title: string;
  serviceName: string;
  fields: PasswordsSecretFieldInput[];
}

export interface PasswordsEmployeeIdentityResponse {
  agentIdentityId: string;
}

export interface PasswordsEmployeeDelegationResponse {
  agentIdentityId: string;
  secretResolutionDelegation: string;
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

export async function createPasswordsApiCredential(
  request: CreatePasswordsApiCredentialRequest,
): Promise<CreatePasswordsApiCredentialResponse> {
  return invokeTauri<CreatePasswordsApiCredentialResponse>(
    "create_passwords_api_credential",
    { request },
  );
}

export async function unlockPasswordsVault(
  masterPassword: string,
): Promise<UnlockPasswordsVaultResponse> {
  return invokeTauri<UnlockPasswordsVaultResponse>("unlock_passwords_vault", {
    request: { masterPassword },
  });
}

export async function setupPasswordsVault(request: {
  masterPassword: string;
  displayName: string;
  vaultName: string;
}): Promise<SetupPasswordsVaultResponse> {
  return invokeTauri<SetupPasswordsVaultResponse>("setup_passwords_vault", {
    request,
  });
}

export async function createPasswordsVault(request: {
  name: string;
  description?: string;
}): Promise<UnlockPasswordsVaultResponse> {
  return invokeTauri<UnlockPasswordsVaultResponse>("create_passwords_vault", {
    request,
  });
}

export async function lockPasswordsVault(): Promise<void> {
  await invokeTauri<void>("lock_passwords_vault");
}

export async function listPasswordsItems(
  vaultId: string,
): Promise<PasswordsItemSummary[]> {
  return invokeTauri<PasswordsItemSummary[]>("list_passwords_items", {
    vaultId,
  });
}

export async function getPasswordsItem(
  vaultId: string,
  itemId: string,
): Promise<PasswordsItemDetail> {
  return invokeTauri<PasswordsItemDetail>("get_passwords_item", {
    vaultId,
    itemId,
  });
}

export async function savePasswordsApiCredential(
  request: SavePasswordsApiCredentialRequest,
): Promise<CreatePasswordsApiCredentialResponse> {
  return invokeTauri<CreatePasswordsApiCredentialResponse>(
    "save_passwords_api_credential",
    { request },
  );
}

export async function savePasswordsEmployeeCredential(request: {
  deploymentId: string;
  title: string;
  serviceName: string;
  fields: PasswordsSecretFieldInput[];
}): Promise<CreatePasswordsApiCredentialResponse> {
  return invokeTauri<CreatePasswordsApiCredentialResponse>(
    "save_passwords_employee_credential",
    { request },
  );
}

export async function ensurePasswordsEmployeeIdentity(
  deploymentId: string,
  displayName: string,
): Promise<PasswordsEmployeeIdentityResponse> {
  return invokeTauri<PasswordsEmployeeIdentityResponse>(
    "ensure_passwords_employee_identity",
    { deploymentId, displayName },
  );
}

export async function createPasswordsEmployeeDelegation(request: {
  deploymentId: string;
  organizationId: string;
  agentIdentityId: string;
  secretRefs: string[];
}): Promise<PasswordsEmployeeDelegationResponse> {
  return invokeTauri<PasswordsEmployeeDelegationResponse>(
    "create_passwords_employee_delegation",
    { request },
  );
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
