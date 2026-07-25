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
import { ApprovalActions } from "@/components/approvals/ApprovalActions";
import { cancelOrchestration } from "@/services/orchestrator";
import {
  grantCapabilityLease,
  type LeaseBudgets,
} from "@/services/tool-authorization";
import { conversationStore } from "@/stores/conversation.store";

interface ShellApprovalRequest {
  approvalId: string;
  command: string;
  timeoutSecs: number;
  threadId?: string | null;
}

/** Leading executable token, path-stripped and lowercased — the same key the
 * gate's command-rule predicates match on (`command_program` in Rust). */
function commandProgram(command: string): string | null {
  const first = command.trim().split(/\s+/)[0];
  if (!first) return null;
  const program = first.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return program.length > 0 ? program : null;
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

    // The same request can be decided from another surface (the inline
    // timeline card or the inbox). Dismiss this dialog when its request is
    // settled elsewhere, so a stale prompt never lingers over a decided action.
    const unlistenResolved = await listen<{ id: string }>(
      "shell-command-approval-response",
      (event) => {
        const req = request();
        if (req && event.payload.id === req.approvalId) {
          setRequest(null);
          setIsProcessing(false);
        }
      },
    );

    onCleanup(() => {
      unlisten();
      unlistenResolved();
    });
  });

  /** Emit the decision and dismiss; idempotent against double clicks. */
  const settle = async (outcome: {
    approved: boolean;
    skipped?: boolean;
  }): Promise<boolean> => {
    const req = request();
    if (!req || isProcessing()) return false;

    setIsProcessing(true);
    try {
      await emit("shell-command-approval-response", {
        id: req.approvalId,
        approved: outcome.approved,
        skipped: outcome.skipped ?? false,
      });
      setRequest(null);
      return true;
    } catch (err) {
      console.error("[ShellApproval] Failed to emit decision:", err);
      setIsProcessing(false);
      return false;
    }
  };

  const handleApprove = async () => {
    console.log("[ShellApproval] Approving command:", request()?.approvalId);
    await settle({ approved: true });
  };

  const handleDeny = async () => {
    console.log("[ShellApproval] Denying command:", request()?.approvalId);
    await settle({ approved: false });
  };

  const handleSkip = async () => {
    console.log("[ShellApproval] Skipping command:", request()?.approvalId);
    await settle({ approved: false, skipped: true });
  };

  const handleStopTask = async () => {
    const req = request();
    const threadId = req?.threadId ?? conversationStore.activeConversationId;
    console.log("[ShellApproval] Stopping task for:", req?.approvalId);
    const settled = await settle({ approved: false });
    if (settled && threadId) {
      try {
        await cancelOrchestration(threadId);
      } catch (err) {
        console.error("[ShellApproval] Failed to stop task:", err);
      }
    }
  };

  const leaseProgram = () => {
    const req = request();
    return req ? commandProgram(req.command) : null;
  };

  const leaseSummary = () => {
    const program = leaseProgram();
    return program ? `"${program}" commands` : "this command";
  };

  /**
   * Grant a reviewed command-rule lease for this task (keyed on the leading
   * program, matching the gate), then approve this call. A failed grant still
   * approves once — the conservative subset of the user's intent.
   */
  const handleApproveForTask = async (
    durationSecs: number,
    budgets: LeaseBudgets,
  ) => {
    const req = request();
    const program = leaseProgram();
    if (!req || isProcessing()) return;

    if (program) {
      const conversationId =
        req.threadId ??
        conversationStore.activeConversationId ??
        "session-without-conversation";
      try {
        await grantCapabilityLease(
          conversationId,
          `Task lease: "${program}" commands`,
          durationSecs,
          { commandRules: [{ program }] },
          budgets,
        );
      } catch (err) {
        console.error(
          "[ShellApproval] Failed to grant task lease; approving once:",
          err,
        );
      }
    }
    await handleApprove();
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

            <ApprovalActions
              isProcessing={isProcessing()}
              approveOnceLabel={
                isProcessing() ? "Processing..." : "Approve once"
              }
              leaseSummary={leaseSummary()}
              onApproveOnce={handleApprove}
              onApproveForTask={handleApproveForTask}
              onDeny={handleDeny}
              onSkip={handleSkip}
              onStopTask={handleStopTask}
            />
          </div>
        </div>
      )}
    </Show>
  );
};

export default ShellApproval;
