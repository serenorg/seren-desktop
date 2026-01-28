// ABOUTME: Settings UI for managing OAuth logins to publisher services.
// ABOUTME: Lists available OAuth providers (GitHub, etc.) and their connection status.

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
  type PublisherOAuthProviderResponse,
  type UserOAuthConnectionResponse,
} from "@/api";
import { listenForOAuthCallback } from "@/lib/tauri-bridge";
import {
  connectPublisher,
  disconnectPublisher,
} from "@/services/publisher-oauth";

export const OAuthLogins: Component = () => {
  const [connectingProvider, setConnectingProvider] = createSignal<
    string | null
  >(null);
  const [disconnectingProvider, setDisconnectingProvider] = createSignal<
    string | null
  >(null);
  const [error, setError] = createSignal<string | null>(null);

  // Fetch available OAuth providers
  const [providers] = createResource(async () => {
    const { data, error } = await listProviders({ throwOnError: false });
    if (error) {
      console.error("[OAuthLogins] Error fetching providers:", error);
      return [];
    }
    return data?.providers || [];
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

  // Listen for OAuth callbacks
  onMount(async () => {
    const unlisten = await listenForOAuthCallback(async (url) => {
      try {
        const urlObj = new URL(url);
        const errorParam = urlObj.searchParams.get("error");

        if (errorParam) {
          setError(`OAuth error: ${errorParam}`);
          setConnectingProvider(null);
          return;
        }

        // Refresh connections after successful OAuth callback
        // The Gateway handles token exchange, we just need to refresh
        await refetchConnections();
        setConnectingProvider(null);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "OAuth callback failed");
        setConnectingProvider(null);
      }
    });

    onCleanup(() => {
      unlisten();
    });
  });

  const isConnected = (
    providerSlug: string,
  ): UserOAuthConnectionResponse | undefined => {
    return connections()?.find(
      (c) => c.provider_slug === providerSlug && c.is_valid,
    );
  };

  const handleConnect = async (provider: PublisherOAuthProviderResponse) => {
    setError(null);
    setConnectingProvider(provider.slug);

    try {
      await connectPublisher(provider.slug);
      // Flow continues via OAuth callback listener
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start OAuth flow",
      );
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

      {/* No Providers Available */}
      <Show when={!providers.loading && providers()?.length === 0}>
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
              const isConnecting = () => connectingProvider() === provider.slug;
              const isDisconnecting = () =>
                disconnectingProvider() === provider.slug;

              return (
                <div
                  class={`flex items-center justify-between px-4 py-4 bg-[rgba(30,30,30,0.6)] border rounded-lg transition-all duration-150 ${
                    connection()
                      ? "border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.05)]"
                      : "border-[rgba(148,163,184,0.2)]"
                  }`}
                >
                  <div class="flex items-center gap-4 flex-1 min-w-0">
                    {/* Provider Icon/Logo */}
                    <Show
                      when={provider.logo_url}
                      fallback={
                        <div class="w-10 h-10 flex items-center justify-center bg-[rgba(148,163,184,0.1)] rounded-lg text-xl">
                          🔗
                        </div>
                      }
                    >
                      {(logoUrl) => (
                        <img
                          src={logoUrl()}
                          alt={provider.name}
                          class="w-10 h-10 rounded-lg object-contain"
                        />
                      )}
                    </Show>

                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-foreground">
                          {provider.name}
                        </span>
                        <Show when={connection()}>
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
                      <Show when={connection()}>
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
                    <Show
                      when={connection()}
                      fallback={
                        <button
                          type="button"
                          class="px-4 py-2 bg-accent border-none rounded-md text-white text-[0.9rem] font-medium cursor-pointer transition-all duration-150 hover:not-disabled:bg-[#4f46e5] disabled:opacity-50 disabled:cursor-not-allowed"
                          onClick={() => handleConnect(provider)}
                          disabled={isConnecting()}
                        >
                          {isConnecting() ? "Connecting..." : "Connect"}
                        </button>
                      }
                    >
                      <button
                        type="button"
                        class="px-4 py-2 bg-transparent border border-[rgba(239,68,68,0.5)] rounded-md text-[#ef4444] text-[0.9rem] cursor-pointer transition-all duration-150 hover:not-disabled:bg-[rgba(239,68,68,0.1)] hover:not-disabled:border-[#ef4444] disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={() => handleDisconnect(provider.slug)}
                        disabled={isDisconnecting()}
                      >
                        {isDisconnecting() ? "Disconnecting..." : "Disconnect"}
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
