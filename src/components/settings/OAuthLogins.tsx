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

/** Minimal publisher info for display under an OAuth provider card */
interface LinkedPublisher {
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
}

/** Combined publisher data: logo map + publishers grouped by OAuth provider */
interface PublisherData {
  logos: Record<string, string>;
  byProvider: Record<string, LinkedPublisher[]>;
}

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

  // Fetch publishers to build logo map and group by OAuth provider
  const [publisherData] = createResource(async (): Promise<PublisherData> => {
    const empty: PublisherData = { logos: {}, byProvider: {} };
    const { data, error } = await listStorePublishers({
      query: { limit: 100 },
      throwOnError: false,
    });
    if (error) return empty;
    const publishers = data?.data || [];
    const logos: Record<string, string> = {};
    const byProvider: Record<string, LinkedPublisher[]> = {};
    for (const pub of publishers) {
      if (!pub.oauth_provider_id) continue;
      const logoUrl = pub.logo_url
        ? pub.logo_url.startsWith("/")
          ? `${apiBase}${pub.logo_url}`
          : pub.logo_url
        : null;
      // First logo per provider wins (for the provider card fallback)
      if (logoUrl && !logos[pub.oauth_provider_id]) {
        logos[pub.oauth_provider_id] = logoUrl;
      }
      // Group publishers under their OAuth provider
      if (!byProvider[pub.oauth_provider_id]) {
        byProvider[pub.oauth_provider_id] = [];
      }
      byProvider[pub.oauth_provider_id].push({
        name: pub.name,
        slug: pub.slug,
        description: pub.description ?? null,
        logoUrl,
      });
    }
    return { logos, byProvider };
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
        <div class="mb-4 px-3.5 py-2.5 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-[13px]">
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
                  return "border-warning/50 bg-warning/[0.08]";
                }
                if (connection()) {
                  return "border-success/30 bg-success/5";
                }
                return "border-border-hover";
              };

              const linked = () =>
                publisherData()?.byProvider[provider.id] ?? [];

              return (
                <div
                  class={`bg-surface-3/60 border rounded-lg transition-all duration-150 ${cardClasses()}`}
                >
                  {/* Provider header row */}
                  <div class="flex items-center justify-between px-4 py-4">
                    <div class="flex items-center gap-4 flex-1 min-w-0">
                      {/* Provider Logo — prefer local bundled logos, then
                           publisher store, then API, with initial-letter fallback */}
                      <Show
                        when={
                          LOCAL_PROVIDER_LOGOS[provider.slug] ||
                          publisherData()?.logos[provider.id] ||
                          provider.logo_url
                        }
                        fallback={
                          <div class="w-10 h-10 flex items-center justify-center bg-border rounded-lg text-base font-semibold text-muted-foreground">
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
                              } else {
                                e.currentTarget.style.display = "none";
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
                            <span class="text-[11px] px-1.5 py-0.5 rounded font-medium bg-warning/20 text-warning/85">
                              Expired
                            </span>
                          </Show>
                          <Show when={connection() && !expired()}>
                            <span class="text-[11px] px-1.5 py-0.5 rounded font-medium bg-success/20 text-success">
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
                          <span class="text-[0.75rem] text-warning/85">
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
                      <Show when={expired()}>
                        <button
                          type="button"
                          class="px-4 py-2 bg-warning/85 border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:not-disabled:bg-warning/70 disabled:opacity-50 disabled:cursor-not-allowed"
                          onClick={() => handleConnect(provider)}
                          disabled={isConnecting()}
                        >
                          {isConnecting() ? "Reconnecting..." : "Reconnect"}
                        </button>
                      </Show>
                      <Show when={connection() && !expired()}>
                        <button
                          type="button"
                          class="px-4 py-2 bg-transparent border border-destructive/50 rounded-md text-destructive text-[0.9rem] cursor-pointer transition-all duration-150 hover:not-disabled:bg-destructive/10 hover:not-disabled:border-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                          onClick={() => handleDisconnect(provider.slug)}
                          disabled={isDisconnecting()}
                        >
                          {isDisconnecting()
                            ? "Disconnecting..."
                            : "Disconnect"}
                        </button>
                      </Show>
                      <Show when={!connection() && !expired()}>
                        <button
                          type="button"
                          class="px-4 py-2 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:not-disabled:bg-primary/85 disabled:opacity-50 disabled:cursor-not-allowed"
                          onClick={() => handleConnect(provider)}
                          disabled={isConnecting()}
                        >
                          {isConnecting() ? "Connecting..." : "Connect"}
                        </button>
                      </Show>
                    </div>
                  </div>

                  {/* Linked publishers sub-list */}
                  <Show when={linked().length > 1}>
                    <div class="px-4 pb-3 pt-0 border-t border-border/50 mt-0">
                      <span class="block text-[0.7rem] text-muted-foreground/70 uppercase tracking-wider pt-2.5 pb-1.5">
                        Services using this connection
                      </span>
                      <div class="flex flex-col gap-1.5">
                        <For each={linked()}>
                          {(pub) => (
                            <div class="flex items-center gap-2.5 py-1">
                              <Show
                                when={pub.logoUrl}
                                fallback={
                                  <div class="w-5 h-5 flex items-center justify-center bg-border/60 rounded text-[10px] font-semibold text-muted-foreground">
                                    {pub.name.charAt(0).toUpperCase()}
                                  </div>
                                }
                              >
                                {(url) => (
                                  <img
                                    src={url()}
                                    alt={pub.name}
                                    class="w-5 h-5 rounded object-contain"
                                    onError={(e) => {
                                      e.currentTarget.style.display = "none";
                                    }}
                                  />
                                )}
                              </Show>
                              <span class="text-[0.8rem] text-foreground/90">
                                {pub.name}
                              </span>
                              <Show when={pub.description}>
                                <span class="text-[0.75rem] text-muted-foreground">
                                  — {pub.description}
                                </span>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Info Box */}
      <div class="mt-6 p-4 bg-primary/10 border border-primary/30 rounded">
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
