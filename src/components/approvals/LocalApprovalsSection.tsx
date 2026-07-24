// ABOUTME: Local-gate section of the approval inbox: pending authorization blocks from this
// ABOUTME: device's tool-authorization gate, with jump-to-thread. Separate from cloud approvals.

import { type Component, For, onMount, Show } from "solid-js";
import {
  pendingApprovals,
  refreshPendingApprovals,
} from "@/stores/approvals.store";
import { threadStore } from "@/stores/thread.store";

/** Matches the executor's fallback session id for gate calls without a thread. */
const NO_CONVERSATION_ID = "session-without-conversation";

function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "-";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  return `${Math.round(diffMin / 60)}h`;
}

/**
 * Pending decisions from the host authorization gate (#3193-D). These are
 * device-local and deliberately not merged with the cloud operator inbox —
 * different backend, different decide flow. Decisions happen on the thread's
 * inline card or modal; this section is the global, navigation-safe view.
 */
export const LocalApprovalsSection: Component = () => {
  onMount(() => {
    void refreshPendingApprovals();
  });

  const openThread = (conversationId: string) => {
    threadStore.selectThread(conversationId, "chat");
    window.dispatchEvent(new CustomEvent("seren:close-inbox"));
  };

  return (
    <Show when={pendingApprovals().length > 0}>
      <div class="mb-5">
        <h2 class="m-0 mb-1 text-[13px] font-semibold text-foreground">
          This device
        </h2>
        <p class="m-0 mb-2 text-[12px] text-muted-foreground">
          Agent actions paused by the local authorization gate. Decide them from
          the thread.
        </p>
        <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
          <For each={pendingApprovals()}>
            {(view) => (
              <li class="border border-warning/40 bg-warning/5 rounded-lg px-3 py-2.5 flex items-center gap-3">
                <div class="min-w-0 flex-1">
                  <div class="text-[13px] text-foreground truncate">
                    {view.requestedCapability.description ||
                      `${view.requestedCapability.publisherSlug}/${view.requestedCapability.toolName}`}
                  </div>
                  <div class="text-[11.5px] text-muted-foreground truncate font-[var(--font-mono)]">
                    {view.requestedCapability.route} ·{" "}
                    {view.requestedCapability.publisherSlug}/
                    {view.requestedCapability.toolName} · waiting{" "}
                    {relativeAge(view.createdAt)}
                  </div>
                </div>
                <Show
                  when={view.taskId !== NO_CONVERSATION_ID}
                  fallback={
                    <span class="text-[11.5px] text-muted-foreground shrink-0">
                      no thread
                    </span>
                  }
                >
                  <button
                    type="button"
                    class="shrink-0 py-1.5 px-3 rounded text-[12px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted"
                    onClick={() => openThread(view.taskId)}
                  >
                    Open thread
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
};

export default LocalApprovalsSection;
