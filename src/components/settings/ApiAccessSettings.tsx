// ABOUTME: Settings UI for the persistent Seren Desktop automation credential.
// ABOUTME: Shows non-secret key metadata, scope drift, and a one-click repair path.

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import {
  DESKTOP_API_KEY_NAME,
  type DesktopApiKeyStatus,
  getDesktopApiKeyStatus,
  repairDesktopApiKey,
} from "@/services/desktop-api-access";
import { initializeGateway, resetGateway } from "@/services/mcp-gateway";
import { authStore } from "@/stores/auth.store";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function stateLabel(status: DesktopApiKeyStatus): string {
  switch (status.state) {
    case "current":
      return "Up to date";
    case "outdated":
      return "Scopes missing";
    case "revoked":
      return "Revoked";
    case "expired":
      return "Expired";
    case "unrecognized":
      return "Not recognized";
    case "missing":
      return "Not provisioned";
  }
}

function safeErrorMessage(error: unknown): string {
  const status = (error as { status?: unknown })?.status;
  if (status === 401 || status === 403) {
    return "Sign in again to inspect or repair API access.";
  }
  return "API access could not be inspected. Check your connection and try again.";
}

export const ApiAccessSettings: Component = () => {
  const [status, setStatus] = createSignal<DesktopApiKeyStatus | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [repairing, setRepairing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  let requestId = 0;

  const refresh = async () => {
    const currentRequest = ++requestId;
    if (!authStore.isAuthenticated) {
      setStatus(null);
      setError("Sign in to inspect the Desktop automation key.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const next = await getDesktopApiKeyStatus();
      if (currentRequest === requestId) setStatus(next);
    } catch (refreshError) {
      if (currentRequest === requestId) {
        setStatus(null);
        setError(safeErrorMessage(refreshError));
      }
    } finally {
      if (currentRequest === requestId) setLoading(false);
    }
  };

  createEffect(() => {
    void authStore.isAuthenticated;
    void refresh();
  });

  const handleRepair = async () => {
    setRepairing(true);
    setError(null);
    setNotice(null);
    try {
      const repaired = await repairDesktopApiKey(status() ?? undefined);
      setStatus(repaired.status);

      try {
        // The gateway caches its authenticated HTTP connection and tool list.
        // Reconnect now so the replacement credential is used immediately.
        await resetGateway();
        await initializeGateway();
        setNotice(
          repaired.warning ??
            "API access repaired. Seren MCP reconnected with the replacement key.",
        );
      } catch {
        setNotice(
          "The key is repaired, but Seren MCP could not reconnect. Restart Seren Desktop before using automation.",
        );
      }
    } catch (repairError) {
      setError(safeErrorMessage(repairError));
    } finally {
      setRepairing(false);
    }
  };

  const badgeClass = createMemo(() =>
    status()?.state === "current"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : "border-amber-500/40 bg-amber-500/10 text-amber-200",
  );

  return (
    <section class="max-w-3xl" data-testid="api-access-settings">
      <div class="mb-6">
        <p class="m-0 mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-accent">
          Automation credential
        </p>
        <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">API Access</h3>
        <p class="m-0 max-w-2xl text-muted-foreground leading-relaxed">
          Inspect the key Seren Desktop uses for MCP publishers and managed
          automation. Its secret stays in your operating system credential store
          and is never shown here.
        </p>
      </div>

      <Show
        when={!loading()}
        fallback={
          <div class="rounded-lg border border-border-strong bg-surface-2/60 px-5 py-8 text-sm text-muted-foreground">
            Inspecting Desktop API access…
          </div>
        }
      >
        <Show when={error()}>
          {(message) => (
            <div
              class="mb-4 flex items-center justify-between gap-4 rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3"
              role="alert"
            >
              <span class="text-sm text-amber-100">{message()}</span>
              <button
                type="button"
                class="shrink-0 rounded-md border border-amber-400/40 bg-transparent px-3 py-1.5 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-400/10 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!authStore.isAuthenticated || loading()}
                onClick={() => void refresh()}
              >
                Try again
              </button>
            </div>
          )}
        </Show>

        <Show when={status()}>
          {(current) => (
            <>
              <Show when={current().needsRepair}>
                <div
                  class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3"
                  data-testid="api-access-mismatch-banner"
                  role="alert"
                >
                  <p class="m-0 text-sm font-semibold text-amber-100">
                    Desktop automation access needs repair
                  </p>
                  <p class="m-0 mt-1 text-xs leading-relaxed text-amber-100/75">
                    This key has an older or different scope set. Re-provision
                    it before relying on MCP automation.
                  </p>
                </div>
              </Show>

              <div class="overflow-hidden rounded-xl border border-border-strong bg-surface-2/70 shadow-sm">
                <div class="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                  <div>
                    <p class="m-0 text-sm font-semibold text-foreground">
                      {current().key?.name ?? DESKTOP_API_KEY_NAME}
                    </p>
                    <p class="m-0 mt-1 font-mono text-xs text-muted-foreground break-all">
                      {current().maskedValue ?? "No stored key"}
                    </p>
                  </div>
                  <span
                    class={`shrink-0 rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wide ${badgeClass()}`}
                  >
                    {stateLabel(current())}
                  </span>
                </div>

                <dl class="m-0 grid grid-cols-2 border-b border-border max-sm:grid-cols-1">
                  <div class="border-r border-border px-5 py-3.5 max-sm:border-b max-sm:border-r-0">
                    <dt class="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      Created
                    </dt>
                    <dd class="m-0 mt-1 text-sm text-foreground">
                      {formatTimestamp(current().key?.created_at)}
                    </dd>
                  </div>
                  <div class="px-5 py-3.5">
                    <dt class="text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      Last used
                    </dt>
                    <dd class="m-0 mt-1 text-sm text-foreground">
                      {formatTimestamp(current().key?.last_used_at)}
                    </dd>
                  </div>
                </dl>

                <div class="grid grid-cols-2 gap-0 max-sm:grid-cols-1">
                  <div class="border-r border-border px-5 py-4 max-sm:border-b max-sm:border-r-0">
                    <p class="m-0 mb-2 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      Current scopes
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <Show
                        when={current().currentScopes.length > 0}
                        fallback={
                          <span class="text-xs text-amber-200">
                            None reported
                          </span>
                        }
                      >
                        <For each={current().currentScopes}>
                          {(scope) => (
                            <code
                              class={`rounded border px-2 py-1 text-[0.72rem] ${
                                current().unexpectedScopes.includes(scope)
                                  ? "border-amber-500/45 bg-amber-500/10 text-amber-100"
                                  : "border-border-strong bg-surface-3/80 text-foreground"
                              }`}
                            >
                              {scope}
                            </code>
                          )}
                        </For>
                      </Show>
                    </div>
                  </div>
                  <div class="px-5 py-4">
                    <p class="m-0 mb-2 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      Required by this build
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <For each={current().requiredScopes}>
                        {(scope) => (
                          <code
                            class={`rounded border px-2 py-1 text-[0.72rem] ${
                              current().missingScopes.includes(scope)
                                ? "border-amber-500/45 bg-amber-500/10 text-amber-100"
                                : "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                            }`}
                          >
                            {scope}
                          </code>
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </div>

              <div class="mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-2/35 px-4 py-3 max-sm:items-stretch max-sm:flex-col">
                <div>
                  <p class="m-0 text-sm font-medium text-foreground">
                    {current().needsRepair
                      ? "Replace the unusable key"
                      : "Re-provision this key"}
                  </p>
                  <p class="m-0 mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Creates a least-privilege replacement, stores it securely,
                    and revokes the previous key.
                  </p>
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded-md border border-accent bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/85 disabled:cursor-wait disabled:opacity-60"
                  data-testid="repair-api-access"
                  disabled={repairing()}
                  onClick={() => void handleRepair()}
                >
                  {repairing() ? "Repairing…" : "Repair / re-provision"}
                </button>
              </div>
            </>
          )}
        </Show>

        <Show when={notice()}>
          {(message) => (
            <p
              class="mt-4 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100"
              aria-live="polite"
            >
              {message()}
            </p>
          )}
        </Show>
      </Show>
    </section>
  );
};

export default ApiAccessSettings;
