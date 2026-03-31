import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";
import { getToken } from "@/services/auth";

export type OrganizationPrivateChatMode = "standard" | "private_org_agent";
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

export interface OrganizationPrivateChatPolicy {
  organization_id: string;
  mode: OrganizationPrivateChatMode;
  deployment_id: string | null;
  deployment_name?: string | null;
  allow_seren_agent?: boolean;
  allow_seren_private_agent?: boolean;
  allow_claude_agent?: boolean;
  allow_codex_agent?: boolean;
  allow_cloud_agent_launch?: boolean;
  model_id?: string | null;
  fallback_models?: string[] | null;
  force_private_model: boolean;
  disable_seren_models: boolean;
  disable_local_agents: boolean;
  disable_external_model_providers: boolean;
  hide_model_picker: boolean;
  session_database: ManagedAgentSessionDatabase | null;
  private_output_policy: ManagedAgentPrivateOutputPolicy;
  updated_at: string;
}

export function allowsSerenAgent(
  policy: OrganizationPrivateChatPolicy | null | undefined,
): boolean {
  return policy?.allow_seren_agent ?? true;
}

export function allowsSerenPrivateAgent(
  policy: OrganizationPrivateChatPolicy | null | undefined,
): boolean {
  return (policy?.allow_seren_private_agent ?? true) && !!policy?.deployment_id;
}

export function allowsClaudeAgent(
  policy: OrganizationPrivateChatPolicy | null | undefined,
): boolean {
  return policy?.allow_claude_agent ?? true;
}

export function allowsCodexAgent(
  policy: OrganizationPrivateChatPolicy | null | undefined,
): boolean {
  return policy?.allow_codex_agent ?? true;
}

export function allowsCloudAgentLaunch(
  policy: OrganizationPrivateChatPolicy | null | undefined,
): boolean {
  return policy?.allow_cloud_agent_launch ?? false;
}

async function authHeaders(url: string): Promise<HeadersInit> {
  const headers: Record<string, string> = {};

  if (!shouldUseRustGatewayAuth(url)) {
    const token = await getToken();
    if (!token) {
      throw new Error("Not authenticated");
    }
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

export async function getDefaultOrganizationPrivateChatPolicy(): Promise<OrganizationPrivateChatPolicy> {
  const url = `${apiBase}/organizations/default/private-chat-policy`;
  const response = await appFetch(url, {
    headers: await authHeaders(url),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(
      `Failed to load organization private chat policy (${response.status}): ${message}`,
    );
  }

  const json = await response.json();
  return json.data as OrganizationPrivateChatPolicy;
}
