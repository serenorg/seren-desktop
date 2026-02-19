// ABOUTME: Status badge for agent task states with animated indicators.
// ABOUTME: Renders colored pill with optional pulse animation for active states.

import type { Component } from "solid-js";
import { Show } from "solid-js";
import type { AgentTaskStatus } from "@/services/agent-tasks";

interface TaskStatusBadgeProps {
  status: AgentTaskStatus;
}

const STATUS_CONFIG: Record<
  AgentTaskStatus,
  { label: string; color: string; bg: string; pulse: boolean }
> = {
  pending: {
    label: "Pending",
    color: "text-muted-foreground",
    bg: "bg-surface-3/60",
    pulse: false,
  },
  submitted: {
    label: "Submitted",
    color: "text-amber-400",
    bg: "bg-amber-400/15",
    pulse: true,
  },
  working: {
    label: "Working",
    color: "text-primary",
    bg: "bg-primary/15",
    pulse: true,
  },
  input_required: {
    label: "Input Required",
    color: "text-amber-300",
    bg: "bg-amber-300/15",
    pulse: true,
  },
  completed: {
    label: "Completed",
    color: "text-emerald-400",
    bg: "bg-emerald-400/15",
    pulse: false,
  },
  failed: {
    label: "Failed",
    color: "text-red-400",
    bg: "bg-red-400/15",
    pulse: false,
  },
  canceled: {
    label: "Canceled",
    color: "text-muted-foreground",
    bg: "bg-surface-3/40",
    pulse: false,
  },
};

export const TaskStatusBadge: Component<TaskStatusBadgeProps> = (props) => {
  const config = () => STATUS_CONFIG[props.status] ?? STATUS_CONFIG.pending;

  return (
    <span
      class={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium tracking-wide uppercase ${config().bg} ${config().color}`}
    >
      <Show when={config().pulse}>
        <span class="relative flex h-1.5 w-1.5">
          <span
            class={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${config().color.replace("text-", "bg-")}`}
          />
          <span
            class={`relative inline-flex rounded-full h-1.5 w-1.5 ${config().color.replace("text-", "bg-")}`}
          />
        </span>
      </Show>
      {config().label}
    </span>
  );
};
