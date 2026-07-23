// ABOUTME: Compact, live disclosure of every data destination used by a conversation.
// ABOUTME: Gives each conversation its memory and history-sync exclusion controls.

import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { privacyStore } from "@/stores/privacy.store";
import { settingsState, settingsStore } from "@/stores/settings.store";
import { threadStore } from "@/stores/thread.store";

interface DataDestinationsPanelProps {
  conversationId?: string | null;
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
  const conversation = createMemo(() =>
    props.conversationId
      ? threadStore.findConversation(props.conversationId)
      : undefined,
  );

  const destinationState = createMemo<Destination[]>(() => [
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

  return (
    <section
      class="w-full max-w-[560px] overflow-hidden rounded-xl border border-[#293438] bg-[#101719] text-[#e8f0ef] shadow-[0_18px_50px_rgba(0,0,0,0.24)]"
      data-testid="data-destinations-panel"
      aria-label="Data destinations"
    >
      <div class="border-b border-[#293438] bg-[linear-gradient(105deg,rgba(116,220,177,0.12),transparent_42%)] px-4 py-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#86d9b8]">
              Data destinations
            </p>
            <h2 class="m-0 mt-1 text-sm font-semibold text-[#f2f7f6]">
              Where this conversation can go
            </h2>
          </div>
          <span class="rounded-full border border-[#345047] bg-[#15241f] px-2 py-1 text-[10px] font-medium text-[#9ce3c3]">
            live state
          </span>
        </div>
        <p class="m-0 mt-2 max-w-[450px] text-xs leading-relaxed text-[#a8b9b5]">
          Controls below update the local capture and synchronization paths
          immediately.
        </p>
      </div>

      <div class="divide-y divide-[#253135]">
        <For each={destinationState()}>
          {(destination) => (
            <div class="flex gap-3 px-4 py-3">
              <span
                class={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  destination.enabled()
                    ? "bg-[#76ddb0] shadow-[0_0_0_3px_rgba(118,221,176,0.12)]"
                    : "bg-[#61716f]"
                }`}
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span class="text-xs font-semibold text-[#e8f0ef]">
                    {destination.label}
                  </span>
                  <span
                    class={`text-[10px] font-semibold uppercase tracking-[0.12em] ${destination.enabled() ? "text-[#86d9b8]" : "text-[#82918f]"}`}
                  >
                    {destination.enabled() ? "active" : "off"}
                  </span>
                </div>
                <p class="m-0 mt-1 text-xs leading-relaxed text-[#a8b9b5]">
                  {destination.detail()}
                </p>
                <p class="m-0 mt-1 text-[10px] text-[#71817e]">
                  {destination.control}
                </p>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={props.conversationId}>
        <div class="border-t border-[#293438] bg-[#0d1416] px-4 py-3">
          <p class="m-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#82918f]">
            Conversation controls
          </p>
          <div class="mt-2 grid gap-2 sm:grid-cols-2">
            <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-[#293438] px-3 py-2 transition-colors hover:border-[#4a6a5e]">
              <input
                type="checkbox"
                class="mt-0.5 accent-[#76ddb0]"
                checked={privacyStore.isMemoryExcluded(props.conversationId)}
                onChange={(event) =>
                  updatePrivacy("excludeMemory", event.currentTarget.checked)
                }
                aria-label="Exclude this conversation from memory"
              />
              <span class="text-xs leading-relaxed text-[#c4d1ce]">
                Exclude from memory capture
              </span>
            </label>
            <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-[#293438] px-3 py-2 transition-colors hover:border-[#4a6a5e]">
              <input
                type="checkbox"
                class="mt-0.5 accent-[#76ddb0]"
                checked={privacyStore.isHistorySyncExcluded(
                  props.conversationId,
                )}
                onChange={(event) =>
                  updatePrivacy(
                    "excludeHistorySync",
                    event.currentTarget.checked,
                  )
                }
                aria-label="Exclude this conversation from history sync"
              />
              <span class="text-xs leading-relaxed text-[#c4d1ce]">
                Exclude from history sync
              </span>
            </label>
          </div>
          <p class="m-0 mt-2 text-[10px] leading-relaxed text-[#71817e]">
            Exclusion takes effect before the next capture or sync drain; queued
            history remains local until you include it again.
          </p>
        </div>
      </Show>
    </section>
  );
};
