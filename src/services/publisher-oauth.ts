// ABOUTME: Publisher OAuth service for gateway-managed OAuth flows.
// ABOUTME: Handles connecting/disconnecting OAuth providers for MCP publishers.

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  listConnections,
  revokeConnection,
  type UserOAuthConnectionResponse,
} from "@/api";
import { apiBase } from "@/lib/config";

/**
 * Start OAuth flow for a publisher provider.
 * Opens authorization URL in user's browser, which will redirect back to seren://oauth/callback.
 */
export async function connectPublisher(providerSlug: string): Promise<void> {
  console.log(`[PublisherOAuth] Starting OAuth flow for ${providerSlug}`);

  // The Gateway will redirect to this URL after OAuth completes
  const redirectUri = "seren://oauth/callback";

  // Initiate OAuth flow - Gateway will redirect to provider's auth page
  const authUrl = `${apiBase}/api/oauth/${providerSlug}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;

  console.log(`[PublisherOAuth] Opening authorization URL: ${authUrl}`);
  await openUrl(authUrl);
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
