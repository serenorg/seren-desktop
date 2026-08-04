// ABOUTME: Compact, live privacy panel showing where a conversation's data can go.
// ABOUTME: Gives each conversation its Privacy Mode and per-path exclusion controls.

import type { Component } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import { privacyStore } from "@/stores/privacy.store";
import { settingsState, settingsStore } from "@/stores/settings.store";
import { threadStore } from "@/stores/thread.store";

interface DataDestinationsPanelProps {
  conversationId?: string | null;
  /** "controls" renders only the actionable switches for starting a chat;
   * "full" (default) also shows the read-only data-destination disclosure. */
  variant?: "controls" | "full";
}

interface Destination {
  label: string;
  detail: () => string;
  control: string;
  enabled: () => boolean;
}

export const DataDestinationsPanel: Component<DataDestinationsPanelProps> = (
  props,
) => {
  const [dismissedConversationIds, setDismissedConversationIds] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const conversation = createMemo(() =>
    props.conversationId
      ? threadStore.findConversation(props.conversationId)
      : undefined,
  );

  const destinationState = createMemo<Destination[]>(() => [
    {
      label: "Privacy Mode",
      detail: () =>
        privacyStore.isPrivileged(props.conversationId)
          ? "Memory, history sync, cloud Notes export, and non-local providers are blocked"
          : "Off — turn on to keep this conversation private",
      control: "Conversation controls",
      enabled: () => privacyStore.isPrivileged(props.conversationId),
    },
    {
      label: "Inference provider",
      detail: () => {
        const provider = conversation()?.provider ?? "selected provider";
        const model = conversation()?.model ?? "selected model";
        return `${provider} · ${model}`;
      },
      control: "Chosen per conversation",
      enabled: () => true,
    },
    {
      label: "Memory capture",
      detail: () =>
        privacyStore.isMemoryExcluded(props.conversationId)
          ? "Excluded for this conversation"
          : "Structured memories may be created from completed turns",
      control: "Settings → Memory",
      enabled: () =>
        settingsState.app.memoryEnabled &&
        !privacyStore.isMemoryExcluded(props.conversationId),
    },
    {
      label: "Verbatim transcript archival",
      detail: () => {
        if (privacyStore.isMemoryExcluded(props.conversationId)) {
          return "Excluded for this conversation";
        }
        if (!settingsState.app.memoryEnabled) {
          return "Memory capture is disabled";
        }
        return settingsStore.get("sourceRetentionEnabled")
          ? "Completed turns may be retained as verbatim sources by cloud memory"
          : "Off by default; derived memories may still be created";
      },
      control: "Settings → Memory",
      enabled: () =>
        settingsState.app.memoryEnabled &&
        settingsStore.get("sourceRetentionEnabled") &&
        !privacyStore.isMemoryExcluded(props.conversationId),
    },
    {
      label: "History sync",
      detail: () =>
        privacyStore.isHistorySyncExcluded(props.conversationId)
          ? "Excluded for this conversation"
          : "Remote history copy, including unsent drafts, every 15 seconds",
      control: "Settings → Sync",
      enabled: () =>
        settingsState.app.historySyncEnabled &&
        !privacyStore.isHistorySyncExcluded(props.conversationId),
    },
    {
      label: "Error telemetry",
      detail: () =>
        settingsState.app.telemetryEnabled
          ? "Scrubbed diagnostics are sent only when an error is captured"
          : "Disabled; queued diagnostics are discarded",
      control: "Settings → General",
      enabled: () => settingsState.app.telemetryEnabled,
    },
    {
      label: "Organization cloud runs",
      detail: () => "Only when an organization workflow is explicitly launched",
      control: "Requires an explicit action",
      enabled: () => false,
    },
    {
      label: "MCP tool arguments",
      detail: () => "Only when a tool is explicitly invoked during this turn",
      control: "Requires an explicit action",
      enabled: () => false,
    },
  ]);

  const updatePrivacy = (
    key: "excludeMemory" | "excludeHistorySync",
    checked: boolean,
  ) => {
    const id = props.conversationId;
    if (!id) return;
    privacyStore.setConversationPrivacy(id, { [key]: checked });
  };

  const updatePrivileged = (checked: boolean) => {
    const id = props.conversationId;
    if (!id) return;
    privacyStore.setConversationPrivacy(id, { privileged: checked });
  };

  const controlsDismissed = () => {
    const id = props.conversationId;
    return (
      props.variant === "controls" &&
      Boolean(id && dismissedConversationIds().has(id))
    );
  };

  const dismissControls = () => {
    const id = props.conversationId;
    if (!id) return;
    setDismissedConversationIds((dismissed) => new Set(dismissed).add(id));
  };

  // In controls mode there is nothing actionable to show without a
  // conversation to scope the switches to.
  if (props.variant === "controls" && !props.conversationId) {
    return null;
  }

  return (
    <section
      class="w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-surface-2 text-foreground shadow-[0_18px_50px_rgba(0,0,0,0.24)]"
      hidden={controlsDismissed()}
      data-testid="data-destinations-panel"
      aria-label="Privacy"
    >
      <Show when={props.variant !== "controls"}>
        <div class="border-b border-border px-4 py-3">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Privacy
              </p>
              <h2 class="m-0 mt-1 text-sm font-semibold text-foreground">
                Where this conversation can go
              </h2>
            </div>
            <span class="rounded-full border border-border bg-surface-3 px-2 py-1 text-[10px] font-medium text-muted-foreground">
              live state
            </span>
          </div>
          <p class="m-0 mt-2 max-w-[450px] text-xs leading-relaxed text-muted-foreground">
            Changes below take effect immediately for this conversation.
          </p>
        </div>

        <div class="divide-y divide-border">
          <For each={destinationState()}>
            {(destination) => (
              <div class="flex gap-3 px-4 py-3">
                <span
                  class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                    destination.enabled()
                      ? "bg-primary shadow-[0_0_0_3px_rgba(56,189,248,0.15)]"
                      : "bg-muted-foreground/40"
                  }`}
                  aria-hidden="true"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span class="text-xs font-semibold text-foreground">
                      {destination.label}
                    </span>
                    <span
                      class={`text-[10px] font-semibold uppercase tracking-[0.12em] ${destination.enabled() ? "text-primary" : "text-muted-foreground"}`}
                    >
                      {destination.enabled() ? "active" : "off"}
                    </span>
                  </div>
                  <p class="m-0 mt-1 text-xs leading-relaxed text-muted-foreground">
                    {destination.detail()}
                  </p>
                  <p class="m-0 mt-1 text-[10px] text-muted-foreground/70">
                    {destination.control}
                  </p>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.conversationId}>
        <div
          class={`bg-surface-3/40 px-4 py-3 ${props.variant === "controls" ? "" : "border-t border-border"}`}
        >
          <div class="flex items-center justify-between gap-3">
            <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Conversation controls
            </p>
            <Show when={props.variant === "controls"}>
              <button
                type="button"
                class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent p-0 text-lg leading-none text-muted-foreground transition-colors hover:border-border hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                onClick={dismissControls}
                title="Dismiss conversation controls"
                aria-label="Dismiss conversation controls"
                data-testid="dismiss-conversation-controls"
              >
                &times;
              </button>
            </Show>
          </div>
          <div class="mt-2 grid gap-2 sm:grid-cols-2">
            <div class="sm:col-span-2 rounded-lg border border-border-strong bg-surface-3 px-3 py-2.5 shadow-[inset_3px_0_0_var(--primary)]">
              <label class="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  class="mt-0.5 accent-primary"
                  checked={privacyStore.isPrivileged(props.conversationId)}
                  onChange={(event) =>
                    updatePrivileged(event.currentTarget.checked)
                  }
                  aria-label="Enable Privacy Mode"
                />
                <span class="min-w-0">
                  <span class="block text-xs font-semibold text-foreground">
                    Privacy Mode
                  </span>
                  <span class="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    Keeps this conversation private: blocks memory, history
                    sync, cloud Notes export, and local search indexing, and
                    uses only privacy-safe providers.
                  </span>
                </span>
              </label>
            </div>
            <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:border-border-hover">
              <input
                type="checkbox"
                class="mt-0.5 accent-primary disabled:cursor-not-allowed"
                checked={privacyStore.isMemoryExcluded(props.conversationId)}
                disabled={privacyStore.isPrivileged(props.conversationId)}
                onChange={(event) =>
                  updatePrivacy("excludeMemory", event.currentTarget.checked)
                }
                aria-label="Exclude this conversation from memory"
              />
              <span class="text-xs leading-relaxed text-foreground">
                Exclude from memory capture
              </span>
            </label>
            <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:border-border-hover">
              <input
                type="checkbox"
                class="mt-0.5 accent-primary disabled:cursor-not-allowed"
                checked={privacyStore.isHistorySyncExcluded(
                  props.conversationId,
                )}
                disabled={privacyStore.isPrivileged(props.conversationId)}
                onChange={(event) =>
                  updatePrivacy(
                    "excludeHistorySync",
                    event.currentTarget.checked,
                  )
                }
                aria-label="Exclude this conversation from history sync"
              />
              <span class="text-xs leading-relaxed text-foreground">
                Exclude from history sync
              </span>
            </label>
          </div>
          <p class="m-0 mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Exclusion takes effect before the next capture or sync drain; queued
            history remains local until you include it again. Privacy Mode locks
            both exclusions on for this conversation.
          </p>
        </div>
      </Show>
    </section>
  );
};
