// ABOUTME: Permission approval dialog for ACP agent tool execution.
// ABOUTME: Shows tool details and lets users approve or deny agent actions.

import { type Component, For, Show } from "solid-js";
import type { PermissionRequestEvent } from "@/services/acp";
import { acpStore } from "@/stores/acp.store";
import "./AcpPermissionDialog.css";

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
    <div class="acp-permission-dialog">
      <div class="acp-permission-header">
        <span class="acp-permission-icon">
          {risk() === "high"
            ? "\u26A0"
            : risk() === "medium"
              ? "\u24D8"
              : "\u2714"}
        </span>
        <span class="acp-permission-title">Permission Required</span>
        <span class={`acp-permission-badge acp-permission-badge--${risk()}`}>
          {risk()}
        </span>
      </div>

      <div class="acp-permission-details">
        <span class="acp-permission-command">{toolDisplay()}</span>
      </div>

      <Show
        when={hasOptions()}
        fallback={
          <div class="acp-permission-actions">
            <button
              class="acp-permission-btn acp-permission-btn--approve"
              onClick={() => handleApprove()}
            >
              Approve
            </button>
            <button
              class="acp-permission-btn acp-permission-btn--deny"
              onClick={handleDeny}
            >
              Deny
            </button>
          </div>
        }
      >
        <div class="acp-permission-options">
          <For each={props.permission.options}>
            {(option) => (
              <button
                class="acp-permission-option-btn"
                onClick={() => handleApprove(option.optionId)}
                title={option.description}
              >
                {option.label || option.optionId}
              </button>
            )}
          </For>
          <button
            class="acp-permission-btn acp-permission-btn--deny"
            onClick={handleDeny}
          >
            Deny
          </button>
        </div>
      </Show>
    </div>
  );
};
