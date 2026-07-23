import {
  getPrivateModelsPolicy,
  type PrivateModelsDataHandlingAttestation,
} from "@/api";

export type { PrivateModelsDataHandlingAttestation } from "@/api";

export type OrganizationPrivateModelsMode = "standard" | "private_org_agent";
export type ManagedAgentSessionDatabaseEngine = "postgres" | "aurora_postgres";
export type ManagedAgentSessionDatabaseProvider =
  | "direct_url"
  | "seren_organization_database";
export type ManagedAgentPrivateOutputPolicy =
  | "control_plane"
  | "private_session_database";

export interface ManagedAgentSessionDatabase {
  provider: ManagedAgentSessionDatabaseProvider;
  engine: ManagedAgentSessionDatabaseEngine;
  url_secret_key?: string | null;
  database_name?: string | null;
}

// Local interface keeps allow_gemini_agent until the upstream OpenAPI
// schema in seren-core exposes it; the field is read from the runtime
// payload and consumers fall back to true when absent.
export interface OrganizationPrivateModelsPolicy {
  organization_id: string;
  mode: OrganizationPrivateModelsMode;
  data_handling_attestation: PrivateModelsDataHandlingAttestation;
  deployment_id: string | null;
  deployment_name?: string | null;
  allow_seren_agent?: boolean;
  allow_seren_private_agent?: boolean;
  allow_claude_agent?: boolean;
  allow_codex_agent?: boolean;
  allow_gemini_agent?: boolean;
  allow_grok_agent?: boolean;
  allow_lmstudio_agent?: boolean;
  allow_cloud_agent_launch?: boolean;
  model_id?: string | null;
  fallback_models?: string[] | null;
  ordered_model_ids?: string[] | null;
  global_ordered_model_ids?: string[] | null;
  disable_seren_models: boolean;
  disable_local_agents: boolean;
  disable_external_model_providers: boolean;
  hide_model_picker: boolean;
  session_database: ManagedAgentSessionDatabase | null;
  private_output_policy: ManagedAgentPrivateOutputPolicy;
  updated_at: string;
}

export type OrganizationPrivateChatMode = OrganizationPrivateModelsMode;
export type OrganizationPrivateChatPolicy = OrganizationPrivateModelsPolicy;

export function hasNoTrainingNoRetentionAttestation(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  const attestation = policy?.data_handling_attestation;
  return (
    attestation?.status === "no_training_no_retention" &&
    attestation.scope === "organization_private_model_inference" &&
    attestation.training_use === "prohibited" &&
    attestation.prompt_retention === "none_after_response" &&
    attestation.output_retention === "none_after_response" &&
    attestation.derived_data_retention === "none_after_response" &&
    attestation.terms === "no_training_no_retention" &&
    attestation.basis === "policy_administrator" &&
    Boolean(attestation.attested_at)
  );
}

export function allowsSerenAgent(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  return policy?.allow_seren_agent ?? true;
}

export function allowsSerenPublicModels(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  if (!policy) {
    return true;
  }

  return (
    policy.mode !== "private_org_agent" &&
    (policy.allow_seren_agent ?? true) &&
    !policy.disable_seren_models
  );
}

export function allowsSerenPrivateAgent(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  return policy?.allow_seren_private_agent ?? true;
}

export function allowsClaudeAgent(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  return policy?.allow_claude_agent ?? true;
}

export function allowsCodexAgent(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  return policy?.allow_codex_agent ?? true;
}

export function allowsGeminiAgent(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  return policy?.allow_gemini_agent ?? true;
}

// Local agents that shipped before allow_grok_agent existed. An admin who set
// every one of these to false expressed a lockdown they had no field to extend
// to Grok, so Grok inherits that answer instead of appearing on upgrade with
// workspace write access.
function disabledEveryPriorLocalAgent(
  policy: OrganizationPrivateModelsPolicy,
): boolean {
  return (
    policy.allow_claude_agent === false &&
    policy.allow_codex_agent === false &&
    policy.allow_gemini_agent === false &&
    policy.allow_lmstudio_agent === false
  );
}

export function allowsGrokAgent(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  if (!policy) return true;
  if (policy.allow_grok_agent !== undefined) return policy.allow_grok_agent;
  if (policy.disable_local_agents) return false;
  return !disabledEveryPriorLocalAgent(policy);
}

export function allowsLmStudioAgent(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  return (
    !policy?.disable_local_agents && (policy?.allow_lmstudio_agent ?? true)
  );
}

export function allowsCloudAgentLaunch(
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  return policy?.allow_cloud_agent_launch ?? false;
}

export async function getDefaultOrganizationPrivateModelsPolicy(): Promise<OrganizationPrivateModelsPolicy> {
  const { data, error, response } = await getPrivateModelsPolicy({
    path: { organization_id: "default" },
    throwOnError: false,
  });
  if (error || !data?.data) {
    const message = await response?.text().catch(() => "");
    throw new Error(
      `Failed to load organization private models policy (${response?.status ?? "?"}): ${message}`,
    );
  }
  return data.data as OrganizationPrivateModelsPolicy;
}

export const getDefaultOrganizationPrivateChatPolicy =
  getDefaultOrganizationPrivateModelsPolicy;
