// ABOUTME: Publisher OAuth service for gateway-managed OAuth flows.
// ABOUTME: Handles connecting/disconnecting OAuth providers for MCP publishers.

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  listConnections,
  revokeConnection,
  type UserOAuthConnectionResponse,
} from "@/api";
import { apiBase } from "@/lib/config";
import { getToken } from "@/lib/tauri-bridge";

/**
 * Start OAuth flow for a publisher provider.
 * Fetches the authorization URL from the Gateway, then opens it in the browser.
 * Uses Tauri invoke to make the request from Rust where redirect: manual works.
 */
export async function connectPublisher(providerSlug: string): Promise<void> {
  console.log(`[PublisherOAuth] Starting OAuth flow for ${providerSlug}`);

  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Please log in first.");
  }

  const redirectUri = "seren://oauth/callback";
  const authUrl = `${apiBase}/oauth/${providerSlug}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;

  // Fetch the authorize endpoint to get the redirect Location header.
  // Tauri's JS fetch ignores redirect: "manual", so we use the Rust backend
  // via invoke to make the request without following redirects.
  const { invoke } = await import("@tauri-apps/api/core");
  const location: string = await invoke("get_oauth_redirect_url", {
    url: authUrl,
    bearerToken: token,
  });

  console.log(`[PublisherOAuth] Opening authorization URL: ${location}`);
  await openUrl(location);
}

/**
 * List user's connected OAuth providers.
 */
export async function listConnectedPublishers(): Promise<
  UserOAuthConnectionResponse[]
> {
  console.log("[PublisherOAuth] Fetching connected OAuth providers");
  const { data, error } = await listConnections({ throwOnError: false });

  if (error) {
    console.error("[PublisherOAuth] Error listing connections:", error);
    throw new Error(`Failed to list connections: ${error}`);
  }

  const connections = data?.connections || [];
  console.log(
    `[PublisherOAuth] Found ${connections.length} connected providers`,
  );
  return connections;
}

/**
 * Disconnect a publisher OAuth provider.
 */
export async function disconnectPublisher(providerSlug: string): Promise<void> {
  console.log(`[PublisherOAuth] Disconnecting ${providerSlug}`);
  const { error } = await revokeConnection({
    path: { provider: providerSlug },
    throwOnError: false,
  });

  if (error) {
    console.error(
      `[PublisherOAuth] Error disconnecting ${providerSlug}:`,
      error,
    );
    throw new Error(`Failed to revoke connection: ${error}`);
  }

  console.log(`[PublisherOAuth] Successfully disconnected ${providerSlug}`);
}

/**
 * Check if a publisher is connected.
 */
export async function isPublisherConnected(
  providerSlug: string,
): Promise<boolean> {
  const connections = await listConnectedPublishers();
  const isConnected = connections.some(
    (c) => c.provider_slug === providerSlug && c.is_valid,
  );
  console.log(`[PublisherOAuth] ${providerSlug} connected: ${isConnected}`);
  return isConnected;
}

/**
 * Get connection details for a provider.
 */
export async function getConnection(
  providerSlug: string,
): Promise<UserOAuthConnectionResponse | null> {
  const connections = await listConnectedPublishers();
  return (
    connections.find((c) => c.provider_slug === providerSlug && c.is_valid) ||
    null
  );
}
