// ABOUTME: Persistent thread status strip: "Waiting for approval" / "N actions blocked",
// ABOUTME: with a toggle for the capability-lease inspect/revoke panel.

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  Show,
} from "solid-js";
import { CapabilityLeasePanel } from "@/components/approvals/CapabilityLeasePanel";
import { listCapabilityLeases } from "@/services/tool-authorization";
import {
  pendingForConversation,
  threadApprovalStatus,
} from "@/stores/approvals.store";

interface ThreadApprovalStatusProps {
  conversationId: string;
}

/**
 * The always-visible blocked-state surface for a thread (#3193 §7). Renders
 * whenever the thread has pending approvals or any capability lease exists, so
 * an authorization block never looks like a hung agent and active authority is
 * always one click from inspection or revocation.
 */
export const ThreadApprovalStatus: Component<ThreadApprovalStatusProps> = (
  props,
) => {
  const [panelOpen, setPanelOpen] = createSignal(false);

  // Re-check lease existence when pending-state changes too: a fresh
  // approve-for-task grant should surface the capabilities button immediately.
  const [leaseCount] = createResource(
    () =>
      [
        props.conversationId,
        pendingForConversation(props.conversationId).length,
      ] as const,
    async ([conversationId]) => {
      try {
        return (await listCapabilityLeases(conversationId)).length;
      } catch {
        return 0;
      }
    },
  );

  const status = createMemo(() => threadApprovalStatus(props.conversationId));
  const visible = createMemo(
    () => status() !== null || (leaseCount() ?? 0) > 0 || panelOpen(),
  );

  return (
    <Show when={visible()}>
      <div class="border-t border-surface-2 bg-surface-1/70">
        <div class="flex items-center gap-2 px-4 py-1.5">
          <Show
            when={status()}
            fallback={
              <span class="text-[0.8rem] text-muted-foreground">
                Task capabilities
              </span>
            }
          >
            {(label) => (
              <span class="inline-flex items-center gap-2 text-[0.8rem] font-medium text-warning">
                <span
                  class="inline-block w-[7px] h-[7px] rounded-full bg-warning animate-pulse"
                  aria-hidden="true"
                />
                {label()}
              </span>
            )}
          </Show>
          <button
            type="button"
            class="ml-auto text-[0.78rem] text-muted-foreground bg-transparent border border-border rounded px-2 py-0.5 cursor-pointer hover:bg-surface-2 hover:text-foreground"
            onClick={() => setPanelOpen((open) => !open)}
          >
            {panelOpen() ? "Hide capabilities" : "Capabilities"}
          </button>
        </div>
        <Show when={panelOpen()}>
          <div class="px-4 pb-3">
            <CapabilityLeasePanel conversationId={props.conversationId} />
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default ThreadApprovalStatus;
