// ABOUTME: Approval dialog for model-requested file access outside the active project.
// ABOUTME: Keeps normal project work automatic and scopes optional grants to the current turn.

import { emit, listen } from "@tauri-apps/api/event";
import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

interface FileAccessApprovalRequest {
  approvalId: string;
  conversationId: string;
  operation: "read" | "write";
  path: string;
  canTrustDirectory: boolean;
}

type FileAccessDecision = "deny" | "approve_once" | "trust_directory";

export const FileAccessApproval: Component = () => {
  const [request, setRequest] = createSignal<FileAccessApprovalRequest | null>(
    null,
  );
  const [isProcessing, setIsProcessing] = createSignal(false);

  onMount(async () => {
    const unlisten = await listen<FileAccessApprovalRequest>(
      "file-access-approval-request",
      (event) => {
        setRequest(event.payload);
        setIsProcessing(false);
      },
    );
    onCleanup(unlisten);
  });

  const respond = async (decision: FileAccessDecision) => {
    const current = request();
    if (!current || isProcessing()) return;

    setIsProcessing(true);
    try {
      await emit("file-access-approval-response", {
        id: current.approvalId,
        decision,
      });
      setRequest(null);
    } catch (error) {
      console.error("[FileAccessApproval] Failed to send response:", error);
      setIsProcessing(false);
    }
  };

  return (
    <Show when={request()}>
      {(current) => (
        <div class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-[4px]">
          <div
            aria-describedby="file-access-description"
            aria-labelledby="file-access-title"
            aria-modal="true"
            class="flex max-h-[80vh] w-[90%] max-w-[600px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-[var(--shadow-lg)]"
            role="dialog"
          >
            <div class="border-b border-border px-6 py-5">
              <h2
                class="m-0 text-xl font-semibold text-foreground"
                id="file-access-title"
              >
                Allow file {current().operation} outside this project?
              </h2>
            </div>

            <div class="flex-1 overflow-y-auto p-6">
              <p
                class="mb-4 mt-0 text-sm leading-6 text-muted-foreground"
                id="file-access-description"
              >
                The agent can work inside the selected project automatically.
                This path is outside that boundary and needs your approval.
              </p>
              <div class="rounded-lg border border-border bg-surface-1 px-4 py-3">
                <span class="mb-2 block text-xs font-medium uppercase tracking-[0.5px] text-muted-foreground">
                  Requested path
                </span>
                <code class="block break-all font-[var(--font-mono)] text-sm text-foreground">
                  {current().path}
                </code>
              </div>
              <p class="mb-0 mt-4 text-sm text-muted-foreground">
                Approve once affects only this operation. Trust folder applies
                only to the same operation for this agent turn.
              </p>
            </div>

            <div class="flex flex-wrap justify-end gap-3 border-t border-border px-6 py-4">
              <button
                class="rounded-md border border-border bg-transparent px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-1"
                disabled={isProcessing()}
                onClick={() => void respond("deny")}
                type="button"
              >
                Deny
              </button>
              <Show when={current().canTrustDirectory}>
                <button
                  class="rounded-md border border-border bg-surface-1 px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-2"
                  disabled={isProcessing()}
                  onClick={() => void respond("trust_directory")}
                  type="button"
                >
                  Trust folder this turn
                </button>
              </Show>
              <button
                class="rounded-md border-0 bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                disabled={isProcessing()}
                onClick={() => void respond("approve_once")}
                type="button"
              >
                {isProcessing() ? "Processing…" : "Approve once"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default FileAccessApproval;
