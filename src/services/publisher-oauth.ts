// ABOUTME: Publisher OAuth service for gateway-managed OAuth flows.
// ABOUTME: Handles connecting/disconnecting OAuth providers for MCP publishers.

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  listConnections,
  listProviders,
  listStorePublishers,
  revokeConnection,
  type UserOAuthConnectionResponse,
} from "@/api";
import { apiBase } from "@/lib/config";
import {
  getKnownOAuthProviderForPublisher,
  humanizeOAuthProviderSlug,
} from "@/lib/oauth-provider-resolution";
import { getToken } from "@/lib/tauri-bridge";
import {
  getDesktopOAuthCallbackUrl,
  getValidationRuntimeInfo,
} from "@/services/oauth-callback";

export interface PublisherOAuthProviderResolution {
  publisherSlug: string;
  providerSlug: string;
  providerName: string;
}

export interface ConnectPublisherOptions {
  /**
   * Used for refresh-token failures where the gateway still has a stale
   * provider grant. Revoking first forces providers like Google through fresh
   * consent so a new refresh token can be minted.
   */
  revokeBeforeConnect?: boolean;
}

let providerLookupPromise: Promise<
  Map<string, PublisherOAuthProviderResolution>
> | null = null;

function fallbackOAuthProviderForPublisher(
  publisherSlug: string,
): PublisherOAuthProviderResolution {
  const known = getKnownOAuthProviderForPublisher(publisherSlug);
  const providerSlug = known?.providerSlug ?? publisherSlug;
  return {
    publisherSlug,
    providerSlug,
    providerName:
      known?.providerName ?? humanizeOAuthProviderSlug(providerSlug),
  };
}

async function loadPublisherOAuthProviderLookup(): Promise<
  Map<string, PublisherOAuthProviderResolution>
> {
  const [providerResult, publisherResult] = await Promise.all([
    listProviders({ throwOnError: false }),
    listStorePublishers({
      query: { limit: 100 },
      throwOnError: false,
    }),
  ]);

  const providers = providerResult.data?.providers ?? [];
  const publishers = publisherResult.data?.data ?? [];
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const lookup = new Map<string, PublisherOAuthProviderResolution>();

  for (const provider of providers) {
    lookup.set(provider.slug, {
      publisherSlug: provider.slug,
      providerSlug: provider.slug,
      providerName: provider.name,
    });
  }

  for (const publisher of publishers) {
    const provider = publisher.oauth_provider_id
      ? providersById.get(publisher.oauth_provider_id)
      : null;
    if (!provider) continue;
    lookup.set(publisher.slug, {
      publisherSlug: publisher.slug,
      providerSlug: provider.slug,
      providerName: provider.name,
    });
  }

  for (const publisher of publishers) {
    const known = getKnownOAuthProviderForPublisher(publisher.slug);
    if (!known || lookup.has(publisher.slug)) continue;
    lookup.set(publisher.slug, {
      publisherSlug: publisher.slug,
      providerSlug: known.providerSlug,
      providerName: known.providerName,
    });
  }

  return lookup;
}

/**
 * Resolve a Gateway publisher slug (e.g. "gmail") to the OAuth provider slug
 * accepted by connectPublisher() (e.g. "google").
 */
export async function resolveOAuthProviderForPublisher(
  publisherSlug: string,
): Promise<PublisherOAuthProviderResolution> {
  providerLookupPromise ??= loadPublisherOAuthProviderLookup();

  try {
    const lookup = await providerLookupPromise;
    return (
      lookup.get(publisherSlug) ??
      fallbackOAuthProviderForPublisher(publisherSlug)
    );
  } catch (err) {
    console.warn(
      `[PublisherOAuth] Failed to resolve OAuth provider for ${publisherSlug}:`,
      err,
    );
    providerLookupPromise = null;
    return fallbackOAuthProviderForPublisher(publisherSlug);
  }
}

/**
 * Start OAuth flow for a publisher provider.
 * Fetches the authorization URL from the Gateway, then opens it in the browser.
 * Uses Tauri invoke to make the request from Rust where redirect: manual works.
 *
 * In dev mode, uses localhost redirect for easier testing without deep link conflicts.
 */
export async function connectPublisher(
  providerSlug: string,
  options: ConnectPublisherOptions = {},
): Promise<void> {
  console.log(`[PublisherOAuth] Starting OAuth flow for ${providerSlug}`);

  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Please log in first.");
  }

  if (options.revokeBeforeConnect) {
    await revokePublisherConnection(providerSlug, { ignoreNotFound: true });
  }

  // Use deep links on macOS/Linux where seren:// URL scheme is registered.
  // Fall back to the app-wide loopback server on Windows and validation
  // builds, where sharing the production deep-link scheme would route the
  // callback to the wrong app instance.
  const isWindows = navigator.userAgent.includes("Windows");
  const runtime = await getValidationRuntimeInfo();
  const redirectUri =
    isWindows || runtime.isValidation
      ? await getDesktopOAuthCallbackUrl("/oauth/callback")
      : "seren://oauth/callback";

  const authUrl = `${apiBase}/oauth/${providerSlug}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;

  // Fetch the authorize endpoint to get the redirect Location header.
  // Tauri's JS fetch ignores redirect: "manual", so we use the Rust backend
  // via invoke to make the request without following redirects.
  const { invoke } = await import("@tauri-apps/api/core");
  const location: string = await invoke("get_oauth_redirect_url", {
    url: authUrl,
    bearerToken: token,
  });

  // Validate the URL before opening to prevent malicious redirects
  if (!location.startsWith("https://")) {
    throw new Error(`Unexpected authorization URL scheme: ${location}`);
  }

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
  await revokePublisherConnection(providerSlug);
  console.log(`[PublisherOAuth] Successfully disconnected ${providerSlug}`);
}

async function revokePublisherConnection(
  providerSlug: string,
  options: { ignoreNotFound?: boolean } = {},
): Promise<void> {
  const { error, response } = await revokeConnection({
    path: { provider: providerSlug },
    throwOnError: false,
  });

  if (error) {
    if (options.ignoreNotFound && response?.status === 404) {
      console.log(
        `[PublisherOAuth] No existing ${providerSlug} connection to revoke`,
      );
      return;
    }
    console.error(
      `[PublisherOAuth] Error disconnecting ${providerSlug}:`,
      error,
    );
    throw new Error(`Failed to revoke connection: ${formatOAuthError(error)}`);
  }
}

function formatOAuthError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(error) ?? String(error);
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
