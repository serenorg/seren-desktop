// ABOUTME: Approval dialog for shell command execution.
// ABOUTME: Shows the command and requires user confirmation before execution.

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { ApprovalActions } from "@/components/approvals/ApprovalActions";
import { shellLeasePredicates } from "@/components/shell/shellLease";
import { cancelOrchestration } from "@/services/orchestrator";
import {
  type CommandRule,
  grantCapabilityLease,
  type LeaseBudgets,
  proposeCapabilityBundle,
} from "@/services/tool-authorization";
import { conversationStore } from "@/stores/conversation.store";

interface ShellApprovalRequest {
  approvalId: string;
  command: string;
  // The command the gate authorized, when it differs from the displayed one:
  // a skill script shows a `cwd> argv` preview but is gated on `argv.join(" ")`.
  // The lease's program key must come from this, not the display string.
  leaseCommand?: string;
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
  // The derived coding toolchain (cargo/pnpm/npm/node/git), owned by the host so
  // the renderer never hard-codes it; empty until loaded / if the load fails.
  const [toolchainRules, setToolchainRules] = createSignal<CommandRule[]>([]);
  // Opt-in: extend a coding-command task lease to the whole toolchain. Default
  // off — a single "Approve for this task" never silently broadens beyond the
  // one blocked program.
  const [coverToolchain, setCoverToolchain] = createSignal(false);

  onMount(async () => {
    // Load the host's coding toolchain once so the opt-in can offer it without
    // the renderer defining which programs a coding lease covers.
    try {
      const bundle = await proposeCapabilityBundle({ profile: "coding" });
      setToolchainRules(bundle.predicates.commandRules ?? []);
    } catch (err) {
      console.error("[ShellApproval] Failed to load coding toolchain:", err);
    }
  });

  // Register cleanup synchronously so it keeps this component's reactive owner:
  // an onCleanup added after an `await` is ownerless and never runs, so the
  // Tauri listeners leaked and stacked on every remount. `disposed` also cancels
  // listeners that resolve after the component has already unmounted.
  onMount(() => {
    let unlisten: UnlistenFn | undefined;
    let unlistenResolved: UnlistenFn | undefined;
    let disposed = false;

    void (async () => {
      unlisten = await listen<ShellApprovalRequest>(
        "shell-command-approval-request",
        (event) => {
          console.log(
            "[ShellApproval] Received approval request:",
            event.payload,
          );
          // Keep a request already on screen rather than letting a concurrent
          // round swap it mid-review; the newer one stays decidable via the
          // inline card / approval inbox.
          if (request()) return;
          setRequest(event.payload);
          setIsProcessing(false);
        },
      );
      // The same request can be decided from another surface (the inline
      // timeline card or the inbox). Dismiss this dialog when its request is
      // settled elsewhere, so a stale prompt never lingers over a decided action.
      unlistenResolved = await listen<{ id: string }>(
        "shell-command-approval-response",
        (event) => {
          const req = request();
          if (req && event.payload.id === req.approvalId) {
            setRequest(null);
            setIsProcessing(false);
          }
        },
      );
      if (disposed) {
        unlisten();
        unlistenResolved();
      }
    })();

    onCleanup(() => {
      disposed = true;
      unlisten?.();
      unlistenResolved?.();
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
    if (!req) return null;
    return commandProgram(req.leaseCommand ?? req.command);
  };

  /** Whether the blocked program is part of the host's coding toolchain — i.e. the
   * opt-in to extend the lease to the whole toolchain is meaningful. */
  const isCodingToolchain = () => {
    const program = leaseProgram();
    return (
      program !== null && toolchainRules().some((r) => r.program === program)
    );
  };

  const toolchainNames = () =>
    toolchainRules()
      .map((r) => r.program)
      .join(", ");

  const leaseSummary = () => {
    const program = leaseProgram();
    if (coverToolchain() && isCodingToolchain()) {
      return `coding toolchain commands (${toolchainNames()})`;
    }
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
          `Task lease: ${leaseSummary()}`,
          durationSecs,
          shellLeasePredicates(program, coverToolchain(), toolchainRules()),
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

              <Show when={isCodingToolchain()}>
                <label class="mt-4 flex items-start gap-2 text-[0.85rem] text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    checked={coverToolchain()}
                    onChange={(event) =>
                      setCoverToolchain(event.currentTarget.checked)
                    }
                    disabled={isProcessing()}
                  />
                  <span>
                    When approving for this task, cover the whole coding
                    toolchain ({toolchainNames()}) instead of just{" "}
                    <span class="font-[var(--font-mono)]">
                      {leaseProgram()}
                    </span>
                    , so a coding run does not re-prompt on each tool.
                  </span>
                </label>
              </Show>
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
