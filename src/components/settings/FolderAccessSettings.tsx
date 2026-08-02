// ABOUTME: Agent-settings surface to grant macOS Desktop/Documents/Downloads (TCC) access.
// ABOUTME: The headless agent shell can't trigger the OS prompt itself, so the app requests the grant here and the agent inherits it.

import { type Component, createSignal, For, onMount, Show } from "solid-js";
import {
  checkFolderAccessPermissions,
  type FolderAccessCheck,
  type FolderAccessKey,
  type FolderAccessPreflight,
  openFolderAccessSettings,
  requestFolderAccessPermission,
} from "@/services/folder-access";

const STATUS_LABEL: Record<FolderAccessCheck["status"], string> = {
  granted: "Granted",
  denied: "Not granted",
  unsupported: "Unsupported",
};

const STATUS_CLASS: Record<FolderAccessCheck["status"], string> = {
  granted: "text-emerald-600 dark:text-emerald-400",
  denied: "text-amber-600 dark:text-amber-400",
  unsupported: "text-muted-foreground",
};

export const FolderAccessSettings: Component = () => {
  const [preflight, setPreflight] = createSignal<FolderAccessPreflight | null>(
    null,
  );
  const [busyKey, setBusyKey] = createSignal<FolderAccessKey | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      setPreflight(await checkFolderAccessPermissions());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  onMount(refresh);

  const isMac = () => preflight()?.platform === "macos";

  const grant = async (key: FolderAccessKey) => {
    setBusyKey(key);
    try {
      // Requesting touches the folder from the foreground app, which surfaces
      // the real macOS consent prompt; the returned preflight reflects the
      // user's choice.
      setPreflight(await requestFolderAccessPermission(key));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyKey(null);
    }
  };

  const openSettings = async () => {
    try {
      await openFolderAccessSettings();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div class="mt-6 flex flex-col gap-2" data-testid="folder-access-settings">
      <h4 class="m-0 text-[1.05rem] font-semibold text-foreground">
        Folder access
      </h4>
      <p class="m-0 text-[0.8rem] text-muted-foreground">
        Agents run in a headless shell, so macOS never prompts them directly.
        Grant Seren access to these folders so agents can read and write files
        in working directories under them.
      </p>

      <Show
        when={preflight()}
        fallback={
          <p class="m-0 text-[0.8rem] text-muted-foreground">
            Checking folder access…
          </p>
        }
      >
        <Show
          when={isMac()}
          fallback={
            <p class="m-0 text-[0.8rem] text-muted-foreground">
              Folder access permissions apply on macOS only.
            </p>
          }
        >
          <div class="flex flex-col gap-1.5">
            <For each={preflight()?.checks}>
              {(check) => (
                <div
                  class="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                  data-testid={`folder-access-${check.key}`}
                >
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-[0.9rem] font-medium text-foreground">
                      {check.label}
                    </span>
                    <span class="truncate text-[0.75rem] text-muted-foreground">
                      {check.path}
                    </span>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <span
                      class={`text-[0.8rem] font-medium ${STATUS_CLASS[check.status]}`}
                      data-testid={`folder-access-status-${check.key}`}
                    >
                      {STATUS_LABEL[check.status]}
                    </span>
                    <Show when={check.canRequest}>
                      <button
                        type="button"
                        class="rounded-md border border-border bg-primary/10 px-2.5 py-1 text-[0.8rem] font-medium text-foreground hover:bg-primary/20 disabled:opacity-50"
                        disabled={busyKey() === check.key}
                        onClick={() => grant(check.key)}
                        data-testid={`folder-access-grant-${check.key}`}
                      >
                        {busyKey() === check.key
                          ? "Requesting…"
                          : "Grant access"}
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>

          <button
            type="button"
            class="mt-1 self-start text-[0.8rem] text-primary hover:underline"
            onClick={openSettings}
            data-testid="folder-access-open-settings"
          >
            Open System Settings → Files and Folders
          </button>
        </Show>
      </Show>

      <Show when={error()}>
        {(message) => (
          <p class="m-0 text-[0.8rem] text-red-600 dark:text-red-400">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
};
