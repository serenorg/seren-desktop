// ABOUTME: Approval dialog for OpenClaw messages when trust level is "approval-required".
// ABOUTME: Shows inbound message, draft AI response, and approve/reject buttons.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

// ============================================================================
// Types
// ============================================================================

interface ApprovalRequest {
  id: string;
  channel: string;
  platform: string;
  /** Recipient identifier (phone number, username, etc.) */
  to: string;
  /** Optional human-friendly label for UI */
  displayName?: string;
  message: string;
  draftResponse: string;
}

// ============================================================================
// Main Component
// ============================================================================

export const OpenClawApprovalManager: Component = () => {
  const [requests, setRequests] = createSignal<ApprovalRequest[]>([]);
  let unlisten: UnlistenFn | undefined;

  onMount(async () => {
    unlisten = await listen<ApprovalRequest>(
      "openclaw://approval-needed",
      (event) => {
        setRequests((prev) => [...prev, event.payload]);
      },
    );
  });

  onCleanup(() => {
    unlisten?.();
  });

  const handleResponse = async (
    request: ApprovalRequest,
    approved: boolean,
  ) => {
    if (approved) {
      // Grant server-side approval so subsequent openclaw_send passes trust check
      await invoke("openclaw_grant_approval", {
        channel: request.channel,
        to: request.to,
      });
    }
    // Emit approval response to unblock the agent's requestApproval() promise
    await invoke("plugin:event|emit", {
      event: "openclaw://approval-response",
      payload: { id: request.id, approved },
    });
    // Remove from queue
    setRequests((prev) => prev.filter((r) => r.id !== request.id));
  };

  return (
    <Show when={requests().length > 0}>
      <div class="fixed bottom-4 right-4 z-[999] flex flex-col gap-2 max-w-[400px]">
        <For each={requests()}>
          {(request) => (
            <ApprovalCard
              request={request}
              onApprove={() => handleResponse(request, true)}
              onReject={() => handleResponse(request, false)}
            />
          )}
        </For>
      </div>
    </Show>
  );
};

// ============================================================================
// Approval Card
// ============================================================================

const ApprovalCard: Component<{
  request: ApprovalRequest;
  onApprove: () => void;
  onReject: () => void;
}> = (props) => {
  return (
    <div class="bg-popover border border-border-strong rounded-xl p-4 shadow-lg">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-[0.75rem] px-1.5 py-0.5 bg-warning/20 text-warning/85 rounded font-medium">
          Approval Required
        </span>
        <span class="text-[0.75rem] text-muted-foreground">
          {props.request.platform}
        </span>
      </div>

      <p class="m-0 mb-1 text-[0.8rem] text-muted-foreground">
        To:{" "}
        <span class="text-foreground font-medium">
          {props.request.displayName ?? props.request.to}
        </span>
      </p>

      <div class="px-3 py-2 mb-2 bg-surface-3/60 border border-border-medium rounded text-[0.85rem] text-foreground max-h-[60px] overflow-y-auto">
        {props.request.message}
      </div>

      <p class="m-0 mb-1 text-[0.75rem] text-muted-foreground">
        Draft response:
      </p>

      <div class="px-3 py-2 mb-3 bg-primary/5 border border-primary/20 rounded text-[0.85rem] text-foreground max-h-[80px] overflow-y-auto">
        {props.request.draftResponse}
      </div>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="px-3 py-1.5 bg-transparent border border-destructive/40 rounded-md text-[0.8rem] text-destructive cursor-pointer transition-all duration-150 hover:bg-destructive/10"
          onClick={props.onReject}
        >
          Reject
        </button>
        <button
          type="button"
          class="px-3 py-1.5 bg-success border-none rounded-md text-[0.8rem] text-white cursor-pointer transition-all duration-150 hover:opacity-80"
          onClick={props.onApprove}
        >
          Send
        </button>
      </div>
    </div>
  );
};

export default OpenClawApprovalManager;
