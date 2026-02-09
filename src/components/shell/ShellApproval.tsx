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
import "./ShellApproval.css";

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
        <div class="shell-approval-overlay">
          <div class="shell-approval-dialog">
            <div class="shell-approval-header">
              <h2 class="shell-approval-title">Confirm Shell Command</h2>
            </div>

            <div class="shell-approval-body">
              <div class="shell-approval-section">
                <span class="shell-approval-label">Command:</span>
                <pre class="shell-approval-command">{req().command}</pre>
              </div>

              <div class="shell-approval-section">
                <span class="shell-approval-label">Timeout:</span>
                <span class="shell-approval-value">{req().timeoutSecs}s</span>
              </div>

              <div class="shell-approval-warning">
                <strong>Warning:</strong> This command will execute on your
                machine. Review it carefully before approving.
              </div>
            </div>

            <div class="shell-approval-footer">
              <button
                type="button"
                class="shell-approval-button shell-approval-deny"
                onClick={handleDeny}
                disabled={isProcessing()}
              >
                Deny
              </button>
              <button
                type="button"
                class="shell-approval-button shell-approval-approve"
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
