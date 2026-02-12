// ABOUTME: Approval dialog for Gateway publisher tool operations.
// ABOUTME: Shows operation details and requires user confirmation before execution.

import { emit, listen } from "@tauri-apps/api/event";
import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

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
        console.log(
          "[GatewayToolApproval] Received approval request:",
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
        const strValue =
          typeof value === "string"
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
        <div class="fixed inset-0 bg-black/70 flex items-center justify-center z-[10000] backdrop-blur-[4px]">
          <div class="bg-background border border-border rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] w-[90%] max-w-[550px] max-h-[80vh] overflow-hidden flex flex-col animate-[slideInDown_200ms_ease-out]">
            <div class="px-6 py-5 border-b border-border">
              <h2 class="m-0 text-xl font-semibold text-foreground">
                {req().isDestructive
                  ? "⚠️ Confirm Destructive Operation"
                  : "🔐 Confirm Operation"}
              </h2>
            </div>

            <div class="p-6 overflow-y-auto flex-1">
              <div class="flex flex-col gap-1.5 mb-4">
                <span class="text-sm font-medium text-muted-foreground uppercase tracking-[0.5px]">
                  Publisher:
                </span>
                <span class="text-base text-foreground font-semibold text-accent">
                  {req().publisherSlug}
                </span>
              </div>

              <div class="flex flex-col gap-1.5 mb-4">
                <span class="text-sm font-medium text-muted-foreground uppercase tracking-[0.5px]">
                  Operation:
                </span>
                <span class="text-base text-foreground">
                  {req().description}
                </span>
              </div>

              <div class="flex flex-col gap-1.5 mb-4">
                <span class="text-sm font-medium text-muted-foreground uppercase tracking-[0.5px]">
                  Endpoint:
                </span>
                <span class="text-base text-foreground font-[var(--font-mono)] text-[0.9rem] bg-surface-1 px-3 py-2 rounded-md border border-border">
                  {req().toolName}
                </span>
              </div>

              <div class="flex flex-col gap-1.5 mb-4">
                <span class="text-sm font-medium text-muted-foreground uppercase tracking-[0.5px]">
                  Parameters:
                </span>
                <span class="text-base text-foreground font-[var(--font-mono)] text-[0.85rem] text-muted-foreground bg-surface-1 px-3 py-2 rounded-md border border-border">
                  {formatArgs(req().args)}
                </span>
              </div>

              <Show when={req().isDestructive}>
                <div class="mt-4 px-4 py-3 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg text-destructive text-[0.9rem]">
                  <strong>Warning:</strong> This operation cannot be undone.
                </div>
              </Show>
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
                class="px-6 py-2.5 text-[0.95rem] font-medium border-none rounded-md cursor-pointer transition-all duration-150 bg-accent text-white hover:bg-[#4f46e5] hover:shadow-[0_2px_8px_rgba(99,102,241,0.3)]"
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
