// ABOUTME: Publisher OAuth service for gateway-managed OAuth flows.
// ABOUTME: Handles connecting/disconnecting OAuth providers for MCP publishers.

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  listConnections,
  revokeConnection,
  type UserOAuthConnectionResponse,
} from "@/api";
import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/tauri-bridge";

/**
 * Start OAuth flow for a publisher provider.
 * Makes an authenticated request to get the provider's redirect URL,
 * then opens it in the user's browser.
 */
export async function connectPublisher(providerSlug: string): Promise<void> {
  console.log(`[PublisherOAuth] Starting OAuth flow for ${providerSlug}`);

  const redirectUri = "seren://oauth/callback";
  const authUrl = `${apiBase}/oauth/${providerSlug}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;

  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Please log in first.");
  }

  // Fetch with redirect: "manual" to capture the Location header
  // instead of following the redirect (which would fail in fetch context)
  const response = await appFetch(authUrl, {
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}` },
  });

  // Gateway returns 302 with Location pointing to the provider's OAuth page
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (!location) {
      throw new Error("Gateway returned redirect without Location header");
    }
    console.log(`[PublisherOAuth] Opening authorization URL: ${location}`);
    await openUrl(location);
    return;
  }

  // If Gateway returns JSON with authorize_url (alternative response format)
  if (response.ok) {
    const data = await response.json();
    const url = data?.authorize_url || data?.url;
    if (url) {
      console.log(`[PublisherOAuth] Opening authorization URL: ${url}`);
      await openUrl(url);
      return;
    }
  }

  const body = await response.text();
  console.error(
    `[PublisherOAuth] Unexpected response: ${response.status}`,
    body,
  );
  throw new Error(`Failed to start OAuth flow (${response.status})`);
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
