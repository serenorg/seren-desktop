// ABOUTME: Compact chat-header OAuth account switcher.
// ABOUTME: Persists active provider account choices per thread.

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { describeOAuthCallbackError } from "@/lib/oauth-callback";
import { humanizeOAuthProviderSlug } from "@/lib/oauth-provider-resolution";
import { listenForOAuthCallback } from "@/lib/tauri-bridge";
import {
  connectPublisher,
  listConnectedPublishers,
} from "@/services/publisher-oauth";
import {
  formatOAuthConnectionLabel,
  getOAuthConnectionsForProvider,
  markOAuthConnectionsChanged,
  type OAuthConnection,
  oauthConnectionsRevision,
  resolveThreadOAuthConnection,
  setThreadOAuthConnectionId,
} from "@/stores/oauth-account.store";

interface OAuthAccountSwitcherProps {
  threadId?: string | null;
}

interface ProviderAccountGroup {
  providerSlug: string;
  connections: OAuthConnection[];
  selected: OAuthConnection | null;
}

function providerSortKey(providerSlug: string): number {
  if (providerSlug === "google") return 0;
  if (providerSlug === "microsoft") return 1;
  return 10;
}

export const OAuthAccountSwitcher: Component<OAuthAccountSwitcherProps> = (
  props,
) => {
  const [open, setOpen] = createSignal(false);
  const [connectingProvider, setConnectingProvider] = createSignal<
    string | null
  >(null);
  const [connectError, setConnectError] = createSignal<string | null>(null);
  let rootRef: HTMLDivElement | undefined;
  let connectTimeout: ReturnType<typeof setTimeout> | null = null;
  const [connections] = createResource(oauthConnectionsRevision, async () =>
    listConnectedPublishers(),
  );

  onMount(() => {
    const close = (event: MouseEvent) => {
      if (
        rootRef &&
        event.target instanceof Node &&
        rootRef.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("click", close);
    onCleanup(() => document.removeEventListener("click", close));
  });

  // Resolve a switcher-initiated add-account flow when its OAuth callback lands.
  // Without this, add-account errors are never shown here and a successful add
  // never refreshes the list.
  onMount(async () => {
    const unlisten = await listenForOAuthCallback((url) => {
      if (!connectingProvider()) return;
      if (connectTimeout) clearTimeout(connectTimeout);
      const callbackError = describeOAuthCallbackError(url);
      if (callbackError) {
        setConnectError(callbackError);
        setConnectingProvider(null);
        return;
      }
      // Success — refresh every account list bound to the revision signal.
      markOAuthConnectionsChanged();
      setConnectError(null);
      setConnectingProvider(null);
    });
    onCleanup(() => {
      unlisten();
      if (connectTimeout) clearTimeout(connectTimeout);
    });
  });

  const groups = createMemo<ProviderAccountGroup[]>(() => {
    const allConnections = connections() ?? [];
    const providerSlugs = Array.from(
      new Set(
        allConnections
          .filter((connection) => connection.is_valid)
          .map((connection) => connection.provider_slug),
      ),
    ).sort(
      (a, b) => providerSortKey(a) - providerSortKey(b) || a.localeCompare(b),
    );

    return providerSlugs
      .map((providerSlug) => {
        const providerConnections = getOAuthConnectionsForProvider(
          allConnections,
          providerSlug,
        );
        return {
          providerSlug,
          connections: providerConnections,
          selected: resolveThreadOAuthConnection(
            props.threadId,
            providerSlug,
            allConnections,
          ),
        };
      })
      .filter((group) => group.connections.length > 0);
  });

  const primaryGroup = createMemo(
    () => groups().find((group) => group.connections.length > 1) ?? groups()[0],
  );

  const primaryConnection = createMemo(() => {
    const group = primaryGroup();
    if (!group) return null;
    return group.selected ?? group.connections[0] ?? null;
  });

  const chooseConnection = (
    providerSlug: string,
    connection: OAuthConnection,
  ) => {
    setThreadOAuthConnectionId(props.threadId, providerSlug, connection.id);
    setOpen(false);
  };

  const addAccount = async (providerSlug: string) => {
    if (connectingProvider()) return;
    setConnectingProvider(providerSlug);
    setConnectError(null);

    // Reset if the OAuth callback never arrives (e.g. the user cancels in the
    // browser). The listener above clears this on a real callback.
    if (connectTimeout) clearTimeout(connectTimeout);
    connectTimeout = setTimeout(() => {
      if (connectingProvider()) {
        setConnectingProvider(null);
        setConnectError("Connection timed out. Please try again.");
      }
    }, 120_000);

    try {
      await connectPublisher(providerSlug);
      // Flow continues via the OAuth callback listener.
    } catch (err) {
      if (connectTimeout) clearTimeout(connectTimeout);
      setConnectError(
        err instanceof Error ? err.message : "Failed to start OAuth flow",
      );
      setConnectingProvider(null);
    }
  };

  return (
    <Show when={primaryConnection()}>
      {(connection) => (
        <div ref={rootRef} class="relative">
          <button
            type="button"
            class="h-7 min-w-7 px-1.5 rounded-full border border-border bg-transparent text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors flex items-center gap-1.5"
            title={`Active account: ${formatOAuthConnectionLabel(connection())}`}
            aria-label="Switch active account"
            aria-expanded={open()}
            data-testid="oauth-account-switcher"
            onClick={() => setOpen((value) => !value)}
          >
            <span class="w-5 h-5 rounded-full bg-surface-2 border border-border flex items-center justify-center text-[10px] font-semibold text-foreground">
              {formatOAuthConnectionLabel(connection()).charAt(0).toUpperCase()}
            </span>
          </button>

          <Show when={open()}>
            <div
              class="absolute right-0 top-9 w-[280px] max-w-[calc(100vw-2rem)] bg-background border border-border rounded-lg shadow-[var(--shadow-lg)] z-50 overflow-hidden"
              role="menu"
            >
              <For each={groups()}>
                {(group) => (
                  <div class="py-2 border-b border-border/60 last:border-b-0">
                    <div class="px-3 pb-1 text-[0.7rem] uppercase tracking-wider text-muted-foreground/75">
                      {humanizeOAuthProviderSlug(group.providerSlug)}
                    </div>
                    <For each={group.connections}>
                      {(item) => {
                        const selected = () =>
                          group.selected?.id === item.id ||
                          (!group.selected && item.is_default);

                        return (
                          <button
                            type="button"
                            class={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 hover:bg-surface-2 transition-colors ${
                              selected()
                                ? "text-foreground"
                                : "text-muted-foreground"
                            }`}
                            role="menuitem"
                            onClick={() =>
                              chooseConnection(group.providerSlug, item)
                            }
                          >
                            <span class="min-w-0">
                              <span class="block text-[0.85rem] truncate">
                                {formatOAuthConnectionLabel(item)}
                              </span>
                              <Show when={item.is_default}>
                                <span class="block text-[0.7rem] text-success">
                                  Default
                                </span>
                              </Show>
                            </span>
                            <Show when={selected()}>
                              <span class="text-success text-xs font-semibold">
                                Active
                              </span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                    <button
                      type="button"
                      class="w-full text-left px-3 py-2.5 flex items-center gap-3 text-muted-foreground hover:bg-surface-2 hover:text-foreground transition-colors border-t border-border/60 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => addAccount(group.providerSlug)}
                      disabled={Boolean(connectingProvider())}
                    >
                      <span class="w-6 h-6 rounded-full border border-dashed border-muted-foreground/50 flex items-center justify-center text-sm">
                        +
                      </span>
                      <span class="text-[0.85rem]">
                        {connectingProvider() === group.providerSlug
                          ? "Opening..."
                          : "Add account"}
                      </span>
                    </button>
                  </div>
                )}
              </For>
              <Show when={connectError()}>
                {(message) => (
                  <div class="px-3 py-2 border-t border-destructive/30 text-[0.75rem] text-destructive">
                    {message()}
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
};

export default OAuthAccountSwitcher;
