// ABOUTME: Approval dialog for Gateway publisher tool operations.
// ABOUTME: Shows operation details and requires user confirmation before execution.

import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import "./GatewayToolApproval.css";

interface ApprovalRequest {
  approvalId: string;
  publisherSlug: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  isDestructive: boolean;
}

export const GatewayToolApproval: Component = () => {
  const [request, setRequest] = createSignal<ApprovalRequest | null>(null);
  const [isProcessing, setIsProcessing] = createSignal(false);

  onMount(async () => {
    const unlisten = await listen<ApprovalRequest>(
      "gateway-tool-approval-request",
      (event) => {
        console.log("[GatewayToolApproval] Received approval request:", event.payload);
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
    console.log("[GatewayToolApproval] Approving operation:", req.approvalId);

    try {
      await emit("gateway-tool-approval-response", {
        id: req.approvalId,
        approved: true,
      });
      setRequest(null);
    } catch (err) {
      console.error("[GatewayToolApproval] Failed to emit approval:", err);
      setIsProcessing(false);
    }
  };

  const handleDeny = async () => {
    const req = request();
    if (!req || isProcessing()) return;

    setIsProcessing(true);
    console.log("[GatewayToolApproval] Denying operation:", req.approvalId);

    try {
      await emit("gateway-tool-approval-response", {
        id: req.approvalId,
        approved: false,
      });
      setRequest(null);
    } catch (err) {
      console.error("[GatewayToolApproval] Failed to emit denial:", err);
      setIsProcessing(false);
    }
  };

  const formatArgs = (args: Record<string, unknown>): string => {
    // Show key operation parameters in a readable format
    const relevant = Object.entries(args)
      .filter(([key]) => !key.startsWith("_")) // Skip internal params
      .slice(0, 3) // Limit to 3 params
      .map(([key, value]) => {
        const strValue = typeof value === "string"
          ? value.length > 50
            ? `${value.slice(0, 50)}...`
            : value
          : JSON.stringify(value);
        return `${key}: ${strValue}`;
      });

    return relevant.length > 0 ? relevant.join(", ") : "No parameters";
  };

  return (
    <Show when={request()}>
      {(req) => (
        <div class="gateway-approval-overlay">
          <div class="gateway-approval-dialog">
            <div class="gateway-approval-header">
              <h2 class="gateway-approval-title">
                {req().isDestructive ? "⚠️ Confirm Destructive Operation" : "🔐 Confirm Operation"}
              </h2>
            </div>

            <div class="gateway-approval-body">
              <div class="gateway-approval-section">
                <span class="gateway-approval-label">Publisher:</span>
                <span class="gateway-approval-value gateway-approval-publisher">
                  {req().publisherSlug}
                </span>
              </div>

              <div class="gateway-approval-section">
                <span class="gateway-approval-label">Operation:</span>
                <span class="gateway-approval-value">{req().description}</span>
              </div>

              <div class="gateway-approval-section">
                <span class="gateway-approval-label">Endpoint:</span>
                <span class="gateway-approval-value gateway-approval-endpoint">
                  {req().toolName}
                </span>
              </div>

              <div class="gateway-approval-section">
                <span class="gateway-approval-label">Parameters:</span>
                <span class="gateway-approval-value gateway-approval-args">
                  {formatArgs(req().args)}
                </span>
              </div>

              <Show when={req().isDestructive}>
                <div class="gateway-approval-warning">
                  <strong>Warning:</strong> This operation cannot be undone.
                </div>
              </Show>
            </div>

            <div class="gateway-approval-footer">
              <button
                type="button"
                class="gateway-approval-button gateway-approval-deny"
                onClick={handleDeny}
                disabled={isProcessing()}
              >
                Deny
              </button>
              <button
                type="button"
                class="gateway-approval-button gateway-approval-approve"
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

export default GatewayToolApproval;
