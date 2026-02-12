// ABOUTME: Settings UI for managing OAuth logins to publisher services.
// ABOUTME: Lists available OAuth providers (GitHub, etc.) and their connection status.

import { listen } from "@tauri-apps/api/event";
import {
  type Component,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  listConnections,
  listProviders,
  listStorePublishers,
  type PublisherOAuthProviderResponse,
  type UserOAuthConnectionResponse,
} from "@/api";
import attioLogo from "@/assets/oauth-logos/attio.svg";
import githubLogo from "@/assets/oauth-logos/github.svg";
import googleLogo from "@/assets/oauth-logos/google.svg";
import linearLogo from "@/assets/oauth-logos/linear.svg";
import { apiBase } from "@/lib/config";
import { listenForOAuthCallback } from "@/lib/tauri-bridge";
import {
  connectPublisher,
  disconnectPublisher,
} from "@/services/publisher-oauth";
import { authStore } from "@/stores/auth.store";

/** Local fallback logos for OAuth providers */
const LOCAL_PROVIDER_LOGOS: Record<string, string> = {
  github: githubLogo,
  google: googleLogo,
  linear: linearLogo,
  attio: attioLogo,
};

/** Event payload for oauth-connection-expired */
interface OAuthExpiredEvent {
  publisherSlug: string;
  errorMessage: string;
  timestamp: number;
}

interface OAuthLoginsProps {
  onSignInClick?: () => void;
}

export const OAuthLogins: Component<OAuthLoginsProps> = (props) => {
  const [connectingProvider, setConnectingProvider] = createSignal<
    string | null
  >(null);
  const [disconnectingProvider, setDisconnectingProvider] = createSignal<
    string | null
  >(null);
  const [error, setError] = createSignal<string | null>(null);
  // Track providers with expired/invalid tokens (detected from tool call failures)
  const [expiredProviders, setExpiredProviders] = createSignal<Set<string>>(
    new Set(),
  );

  // Fetch available OAuth providers
  const [providers] = createResource(async () => {
    const { data, error } = await listProviders({ throwOnError: false });
    if (error) {
      console.error("[OAuthLogins] Error fetching providers:", error);
      return [];
    }
    const providers = data?.providers || [];
    console.log(
      "[OAuthLogins] OAuth providers:",
      providers.map((p) => ({
        name: p.name,
        id: p.id,
        slug: p.slug,
        logo_url: p.logo_url,
      })),
    );
    return providers;
  });

  // Fetch publishers to get logo URLs keyed by oauth_provider_id
  const [publisherLogos] = createResource(async () => {
    const { data, error } = await listStorePublishers({
      query: { limit: 100 },
      throwOnError: false,
    });
    if (error) return {} as Record<string, string>;
    const logos: Record<string, string> = {};
    const publishers = data?.data || [];
    console.log(
      "[OAuthLogins] Publishers with OAuth:",
      publishers
        .filter((p) => p.oauth_provider_id)
        .map((p) => ({
          name: p.name,
          oauth_provider_id: p.oauth_provider_id,
          logo_url: p.logo_url,
        })),
    );
    for (const pub of publishers) {
      if (pub.oauth_provider_id && pub.logo_url) {
        const url = pub.logo_url.startsWith("/")
          ? `${apiBase}${pub.logo_url}`
          : pub.logo_url;
        logos[pub.oauth_provider_id] = url;
      }
    }
    console.log("[OAuthLogins] Logo map:", logos);
    return logos;
  });

  // Fetch user's connected OAuth accounts
  const [connections, { refetch: refetchConnections }] = createResource(
    async () => {
      const { data, error } = await listConnections({ throwOnError: false });
      if (error) {
        console.error("[OAuthLogins] Error fetching connections:", error);
        return [];
      }
      return data?.connections || [];
    },
  );

  // Listen for OAuth token expiration events from tool executor
  onMount(async () => {
    console.log("[OAuthLogins] Setting up oauth-connection-expired listener");
    const unlistenExpired = await listen<OAuthExpiredEvent>(
      "oauth-connection-expired",
      (event) => {
        const { publisherSlug, errorMessage } = event.payload;
        console.log(
          `[OAuthLogins] OAuth connection expired for ${publisherSlug}:`,
          errorMessage,
        );
        // Add to expired providers set
        setExpiredProviders((prev) => {
          const next = new Set(prev);
          next.add(publisherSlug);
          return next;
        });
      },
    );

    onCleanup(() => {
      unlistenExpired();
    });
  });

  // Listen for OAuth callbacks
  onMount(async () => {
    console.log("[OAuthLogins] Setting up OAuth callback listener");
    const unlisten = await listenForOAuthCallback(async (url) => {
      // Only process if we initiated a publisher OAuth flow
      if (!connectingProvider()) return;

      console.log("[OAuthLogins] Received OAuth callback URL:", url);
      try {
        const urlObj = new URL(url);
        console.log(
          "[OAuthLogins] Parsed URL - origin:",
          urlObj.origin,
          "pathname:",
          urlObj.pathname,
          "search:",
          urlObj.search,
        );
        const errorParam = urlObj.searchParams.get("error");

        if (errorParam) {
          console.log("[OAuthLogins] OAuth error received:", errorParam);
          if (connectTimeout) clearTimeout(connectTimeout);
          setError(`OAuth error: ${errorParam}`);
          setConnectingProvider(null);
          return;
        }

        // Refresh connections after successful OAuth callback
        // The Gateway handles token exchange, we just need to refresh
        console.log(
          "[OAuthLogins] Refreshing connections after successful OAuth",
        );
        await refetchConnections();
        console.log("[OAuthLogins] Connections refreshed successfully");
        // Clear expired status for this provider since they just reconnected
        const currentProvider = connectingProvider();
        if (currentProvider) {
          clearExpiredStatus(currentProvider);
        }
        if (connectTimeout) clearTimeout(connectTimeout);
        setConnectingProvider(null);
        setError(null);
      } catch (err) {
        console.error("[OAuthLogins] Error processing OAuth callback:", err);
        if (connectTimeout) clearTimeout(connectTimeout);
        setError(err instanceof Error ? err.message : "OAuth callback failed");
        setConnectingProvider(null);
      }
    });

    onCleanup(() => {
      unlisten();
      if (connectTimeout) clearTimeout(connectTimeout);
    });
  });

  const isConnected = (
    providerSlug: string,
  ): UserOAuthConnectionResponse | undefined => {
    return connections()?.find(
      (c) => c.provider_slug === providerSlug && c.is_valid,
    );
  };

  const isExpired = (providerSlug: string): boolean => {
    return expiredProviders().has(providerSlug);
  };

  const clearExpiredStatus = (providerSlug: string) => {
    setExpiredProviders((prev) => {
      const next = new Set(prev);
      next.delete(providerSlug);
      return next;
    });
  };

  let connectTimeout: ReturnType<typeof setTimeout> | null = null;

  const handleConnect = async (provider: PublisherOAuthProviderResponse) => {
    // Guard against double-clicks while already connecting
    if (connectingProvider()) return;

    console.log(
      "[OAuthLogins] Starting OAuth flow for provider:",
      provider.slug,
    );
    setError(null);
    setConnectingProvider(provider.slug);

    // Reset after 2 minutes if callback never arrives
    if (connectTimeout) clearTimeout(connectTimeout);
    connectTimeout = setTimeout(() => {
      if (connectingProvider()) {
        setConnectingProvider(null);
        setError("Connection timed out. Please try again.");
      }
    }, 120_000);

    try {
      await connectPublisher(provider.slug);
      // Flow continues via OAuth callback listener
    } catch (err) {
      if (connectTimeout) clearTimeout(connectTimeout);
      console.error(
        `[OAuthLogins] OAuth connect error for ${provider.slug}:`,
        err,
      );
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to connect: ${errorMessage}`);
      setConnectingProvider(null);
    }
  };

  const handleDisconnect = async (providerSlug: string) => {
    const confirmDisconnect = window.confirm(
      `Disconnect from ${providerSlug}? You'll need to reconnect to use publishers that require this authentication.`,
    );
    if (!confirmDisconnect) return;

    setError(null);
    setDisconnectingProvider(providerSlug);

    try {
      await disconnectPublisher(providerSlug);
      await refetchConnections();
      setDisconnectingProvider(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
      setDisconnectingProvider(null);
    }
  };

  const formatDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <section>
      <h3 class="m-0 mb-2 text-[1.3rem] font-semibold text-foreground">
        Connected Accounts
      </h3>
      <p class="m-0 mb-6 text-muted-foreground leading-normal">
        Connect your accounts to use publishers that require authentication.
        Some MCP tools (like GitHub) need OAuth access to work on your behalf.
      </p>

      {/* Error Display */}
      <Show when={error()}>
        <div class="mb-4 px-3.5 py-2.5 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-md text-[#ef4444] text-[13px]">
          {error()}
        </div>
      </Show>

      {/* Loading State */}
      <Show when={providers.loading || connections.loading}>
        <div class="flex items-center gap-2 py-8 text-muted-foreground">
          <span class="animate-pulse">Loading available providers...</span>
        </div>
      </Show>

      {/* Not Signed In */}
      <Show when={!authStore.isAuthenticated}>
        <div class="text-center py-10 px-6 text-muted-foreground">
          <span class="text-[2.5rem] block mb-3 opacity-60">🔐</span>
          <p class="m-0 mb-3">Sign in to connect accounts</p>
          <button
            type="button"
            class="px-4 py-2 text-sm font-medium text-white bg-blue-600 border-none rounded cursor-pointer transition-colors duration-100 hover:bg-blue-500"
            onClick={() => props.onSignInClick?.()}
          >
            Sign In
          </button>
        </div>
      </Show>

      {/* No Providers Available (when signed in) */}
      <Show
        when={
          authStore.isAuthenticated &&
          !providers.loading &&
          providers()?.length === 0
        }
      >
        <div class="text-center py-10 px-6 text-muted-foreground">
          <span class="text-[2.5rem] block mb-3 opacity-60">🔐</span>
          <p class="m-0">No OAuth providers available</p>
          <p class="m-0 mt-2 text-[0.85rem] text-muted-foreground">
            OAuth providers will appear here when publishers require
            authentication.
          </p>
        </div>
      </Show>

      {/* Provider List */}
      <Show when={!providers.loading && (providers()?.length ?? 0) > 0}>
        <div class="flex flex-col gap-2">
          <For each={providers()}>
            {(provider) => {
              const connection = () => isConnected(provider.slug);
              const expired = () => isExpired(provider.slug);
              const isConnecting = () => connectingProvider() === provider.slug;
              const isDisconnecting = () =>
                disconnectingProvider() === provider.slug;

              // Determine card border/background based on state
              const cardClasses = () => {
                if (expired()) {
                  return "border-[rgba(245,158,11,0.5)] bg-[rgba(245,158,11,0.08)]";
                }
                if (connection()) {
                  return "border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.05)]";
                }
                return "border-[rgba(148,163,184,0.2)]";
              };

              return (
                <div
                  class={`flex items-center justify-between px-4 py-4 bg-[rgba(30,30,30,0.6)] border rounded-lg transition-all duration-150 ${cardClasses()}`}
                >
                  <div class="flex items-center gap-4 flex-1 min-w-0">
                    {/* Publisher Logo — prefer local bundled logos, then
                         publisher store, then API, with initial-letter fallback */}
                    <Show
                      when={
                        LOCAL_PROVIDER_LOGOS[provider.slug] ||
                        publisherLogos()?.[provider.id] ||
                        provider.logo_url
                      }
                      fallback={
                        <div class="w-10 h-10 flex items-center justify-center bg-[rgba(148,163,184,0.1)] rounded-lg text-base font-semibold text-muted-foreground">
                          {provider.name?.charAt(0).toUpperCase() ?? "?"}
                        </div>
                      }
                    >
                      {(logoUrl) => (
                        <img
                          src={logoUrl()}
                          alt={provider.name}
                          class="w-10 h-10 rounded-lg object-contain"
                          onError={(e) => {
                            const fallback =
                              LOCAL_PROVIDER_LOGOS[provider.slug];
                            if (
                              fallback &&
                              e.currentTarget.src !== fallback
                            ) {
                              e.currentTarget.src = fallback;
                            }
                          }}
                        />
                      )}
                    </Show>

                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-foreground">
                          {provider.name}
                        </span>
                        <Show when={expired()}>
                          <span class="text-[11px] px-1.5 py-0.5 rounded font-medium bg-[rgba(245,158,11,0.2)] text-[#f59e0b]">
                            Expired
                          </span>
                        </Show>
                        <Show when={connection() && !expired()}>
                          <span class="text-[11px] px-1.5 py-0.5 rounded font-medium bg-[rgba(34,197,94,0.2)] text-[#4ade80]">
                            Connected
                          </span>
                        </Show>
                      </div>
                      <Show when={provider.description}>
                        <span class="text-[0.8rem] text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                          {provider.description}
                        </span>
                      </Show>
                      <Show when={expired()}>
                        <span class="text-[0.75rem] text-[#f59e0b]">
                          Token expired - please reconnect to continue using
                          this service
                        </span>
                      </Show>
                      <Show when={!expired() && connection()}>
                        {(conn) => (
                          <span class="text-[0.75rem] text-muted-foreground">
                            {conn().provider_email
                              ? `Connected as ${conn().provider_email}`
                              : `Last used: ${formatDate(conn().last_used_at)}`}
                          </span>
                        )}
                      </Show>
                    </div>
                  </div>

                  <div class="flex items-center gap-2 ml-4">
                    {/* Expired state: show Reconnect button */}
                    <Show when={expired()}>
                      <button
                        type="button"
                        class="px-4 py-2 bg-[#f59e0b] border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:not-disabled:bg-[#d97706] disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={() => handleConnect(provider)}
                        disabled={isConnecting()}
                      >
                        {isConnecting() ? "Reconnecting..." : "Reconnect"}
                      </button>
                    </Show>
                    {/* Connected state (not expired): show Disconnect button */}
                    <Show when={connection() && !expired()}>
                      <button
                        type="button"
                        class="px-4 py-2 bg-transparent border border-[rgba(239,68,68,0.5)] rounded-md text-[#ef4444] text-[0.9rem] cursor-pointer transition-all duration-150 hover:not-disabled:bg-[rgba(239,68,68,0.1)] hover:not-disabled:border-[#ef4444] disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={() => handleDisconnect(provider.slug)}
                        disabled={isDisconnecting()}
                      >
                        {isDisconnecting() ? "Disconnecting..." : "Disconnect"}
                      </button>
                    </Show>
                    {/* Not connected and not expired: show Connect button */}
                    <Show when={!connection() && !expired()}>
                      <button
                        type="button"
                        class="px-4 py-2 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:not-disabled:bg-[#4f46e5] disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={() => handleConnect(provider)}
                        disabled={isConnecting()}
                      >
                        {isConnecting() ? "Connecting..." : "Connect"}
                      </button>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Info Box */}
      <div class="mt-6 p-4 bg-[rgba(99,102,241,0.1)] border border-[rgba(99,102,241,0.3)] rounded">
        <h4 class="m-0 mb-2 text-sm font-semibold text-foreground">
          Why Connect Accounts?
        </h4>
        <ul class="m-0 pl-4 text-[0.8rem] text-muted-foreground space-y-2">
          <li>
            Some MCP publishers (like GitHub) need your OAuth credentials to
            perform actions on your behalf
          </li>
          <li>
            Once connected, the AI can create issues, pull requests, and more
            using your account
          </li>
          <li>
            Your tokens are securely stored and you can disconnect at any time
          </li>
        </ul>
      </div>
    </section>
  );
};

export default OAuthLogins;
