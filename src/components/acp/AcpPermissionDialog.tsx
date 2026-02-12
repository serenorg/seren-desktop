// ABOUTME: Permission approval dialog for ACP agent tool execution.
// ABOUTME: Shows tool details and lets users approve or deny agent actions.

import { type Component, For, Show } from "solid-js";
import type { PermissionRequestEvent } from "@/services/acp";
import { acpStore } from "@/stores/acp.store";

export interface AcpPermissionDialogProps {
  permission: PermissionRequestEvent;
}

function getRiskLevel(toolCall: unknown): "low" | "medium" | "high" {
  if (!toolCall || typeof toolCall !== "object") return "medium";
  const call = toolCall as Record<string, unknown>;
  const name = (call.title as string) || (call.name as string) || "";

  if (
    name.includes("terminal") ||
    name.includes("bash") ||
    name.includes("shell")
  ) {
    return "high";
  }
  if (
    name.includes("write") ||
    name.includes("delete") ||
    name.includes("remove")
  ) {
    return "medium";
  }
  return "low";
}

function formatToolCall(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object") return "Unknown action";
  const call = toolCall as Record<string, unknown>;
  const name = (call.title as string) || (call.name as string) || "unknown";
  const input = call.input || call.arguments;
  if (input && typeof input === "object") {
    const args = input as Record<string, unknown>;
    if (args.command) return `${name}: ${args.command}`;
    if (args.path) return `${name}: ${args.path}`;
  }
  return name;
}

export const AcpPermissionDialog: Component<AcpPermissionDialogProps> = (
  props,
) => {
  const risk = () => getRiskLevel(props.permission.toolCall);
  const toolDisplay = () => formatToolCall(props.permission.toolCall);
  const hasOptions = () => props.permission.options.length > 0;

  function handleApprove(optionId?: string) {
    const id =
      optionId || props.permission.options[0]?.optionId || "allow_once";
    acpStore.respondToPermission(props.permission.requestId, id);
  }

  function handleDeny() {
    acpStore.dismissPermission(props.permission.requestId);
  }

  return (
    <div class="border border-border rounded-lg px-4 py-3 my-2 bg-surface-1">
      <div class="flex items-center gap-2 mb-2">
        <span class="text-base shrink-0">
          {risk() === "high"
            ? "\u26A0"
            : risk() === "medium"
              ? "\u24D8"
              : "\u2714"}
        </span>
        <span class="font-semibold text-[13px] text-foreground">
          Permission Required
        </span>
        <span
          class="text-[11px] px-1.5 py-0.5 rounded font-medium"
          classList={{
            "bg-success/[0.12] text-success": risk() === "low",
            "bg-warning/[0.12] text-warning": risk() === "medium",
            "bg-destructive/[0.12] text-destructive": risk() === "high",
          }}
        >
          {risk()}
        </span>
      </div>

      <div class="bg-surface-0 rounded-md px-3 py-2 mb-2.5 font-[var(--font-mono)] text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto">
        <span class="text-foreground font-medium">{toolDisplay()}</span>
      </div>

      <Show
        when={hasOptions()}
        fallback={
          <div class="flex gap-2 items-center">
            <button
              class="px-3.5 py-1.5 rounded-md border-none text-xs font-medium cursor-pointer transition-opacity duration-150 hover:opacity-85 bg-primary text-white"
              onClick={() => handleApprove()}
            >
              Approve
            </button>
            <button
              class="px-3.5 py-1.5 rounded-md border-none text-xs font-medium cursor-pointer transition-opacity duration-150 hover:opacity-85 bg-surface-3 text-muted-foreground"
              onClick={handleDeny}
            >
              Deny
            </button>
          </div>
        }
      >
        <div class="flex gap-1.5 flex-wrap">
          <For each={props.permission.options}>
            {(option) => (
              <button
                class="px-2.5 py-1 rounded border border-border bg-transparent text-muted-foreground text-[11px] cursor-pointer transition-all duration-150 hover:border-primary hover:text-foreground"
                onClick={() => handleApprove(option.optionId)}
                title={option.description}
              >
                {option.label || option.optionId}
              </button>
            )}
          </For>
          <button
            class="px-3.5 py-1.5 rounded-md border-none text-xs font-medium cursor-pointer transition-opacity duration-150 hover:opacity-85 bg-surface-3 text-muted-foreground"
            onClick={handleDeny}
          >
            Deny
          </button>
        </div>
      </Show>
    </div>
  );
};
