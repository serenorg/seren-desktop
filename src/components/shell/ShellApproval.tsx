// ABOUTME: Approval dialog for shell command execution.
// ABOUTME: Shows the command and requires user confirmation before execution.

import { emit, listen } from "@tauri-apps/api/event";
import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

interface ShellApprovalRequest {
  approvalId: string;
  command: string;
  timeoutSecs: number;
}

export const ShellApproval: Component = () => {
  const [request, setRequest] = createSignal<ShellApprovalRequest | null>(null);
  const [isProcessing, setIsProcessing] = createSignal(false);

  onMount(async () => {
    const unlisten = await listen<ShellApprovalRequest>(
      "shell-command-approval-request",
      (event) => {
        console.log(
          "[ShellApproval] Received approval request:",
          event.payload,
        );
        setRequest(event.payload);
        setIsProcessing(false);
      },
    );

    onCleanup(() => {
      unlisten();
    });
  });

  const handleApprove = async () => {
    const req = request();
    if (!req || isProcessing()) return;

    setIsProcessing(true);
    console.log("[ShellApproval] Approving command:", req.approvalId);

    try {
      await emit("shell-command-approval-response", {
        id: req.approvalId,
        approved: true,
      });
      setRequest(null);
    } catch (err) {
      console.error("[ShellApproval] Failed to emit approval:", err);
      setIsProcessing(false);
    }
  };

  const handleDeny = async () => {
    const req = request();
    if (!req || isProcessing()) return;

    setIsProcessing(true);
    console.log("[ShellApproval] Denying command:", req.approvalId);

    try {
      await emit("shell-command-approval-response", {
        id: req.approvalId,
        approved: false,
      });
      setRequest(null);
    } catch (err) {
      console.error("[ShellApproval] Failed to emit denial:", err);
      setIsProcessing(false);
    }
  };

  return (
    <Show when={request()}>
      {(req) => (
        <div class="fixed inset-0 bg-black/70 flex items-center justify-center z-[10000] backdrop-blur-[4px]">
          <div class="bg-background border border-border rounded-xl shadow-[var(--shadow-lg)] w-[90%] max-w-[550px] max-h-[80vh] overflow-hidden flex flex-col animate-[slideInDown_200ms_ease-out]">
            <div class="px-6 py-5 border-b border-border">
              <h2 class="m-0 text-xl font-semibold text-foreground">
                Confirm Shell Command
              </h2>
            </div>

            <div class="p-6 overflow-y-auto flex-1">
              <div class="flex flex-col gap-1.5 mb-4">
                <span class="text-sm font-medium text-muted-foreground uppercase tracking-[0.5px]">
                  Command:
                </span>
                <pre class="font-[var(--font-mono)] text-[0.9rem] bg-surface-1 px-4 py-3 rounded-md border border-border text-foreground whitespace-pre-wrap break-all m-0 overflow-x-auto">
                  {req().command}
                </pre>
              </div>

              <div class="flex flex-col gap-1.5 mb-4">
                <span class="text-sm font-medium text-muted-foreground uppercase tracking-[0.5px]">
                  Timeout:
                </span>
                <span class="text-base text-foreground">
                  {req().timeoutSecs}s
                </span>
              </div>

              <div class="mt-4 px-4 py-3 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-[0.9rem]">
                <strong>Warning:</strong> This command will execute on your
                machine. Review it carefully before approving.
              </div>
            </div>

            <div class="px-6 py-4 border-t border-border flex gap-3 justify-end">
              <button
                type="button"
                class="px-6 py-2.5 text-[0.95rem] font-medium border-none rounded-md cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-surface-1 hover:border-muted-foreground"
                onClick={handleDeny}
                disabled={isProcessing()}
              >
                Deny
              </button>
              <button
                type="button"
                class="px-6 py-2.5 text-[0.95rem] font-medium border-none rounded-md cursor-pointer transition-all duration-150 bg-accent text-white hover:bg-primary-hover hover:shadow-[0_2px_8px_var(--primary-muted)]"
                onClick={handleApprove}
                disabled={isProcessing()}
              >
                {isProcessing() ? "Processing..." : "Approve"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default ShellApproval;
