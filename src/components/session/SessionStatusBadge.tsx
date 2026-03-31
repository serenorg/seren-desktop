// ABOUTME: Displays a compact status badge for a runtime session.
// ABOUTME: Color-coded pill showing current session state.

import type { Component } from "solid-js";
import type { SessionStatus } from "@/types/session";

interface SessionStatusBadgeProps {
  status: SessionStatus;
  class?: string;
}

const STATUS_CONFIG: Record<
  SessionStatus,
  { label: string; bg: string; text: string; dot: string }
> = {
  idle: {
    label: "Idle",
    bg: "bg-surface-2",
    text: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  running: {
    label: "Running",
    bg: "bg-primary/15",
    text: "text-primary",
    dot: "bg-primary",
  },
  waiting_approval: {
    label: "Awaiting Approval",
    bg: "bg-amber-500/15",
    text: "text-amber-400",
    dot: "bg-amber-400",
  },
  completed: {
    label: "Completed",
    bg: "bg-emerald-500/15",
    text: "text-emerald-400",
    dot: "bg-emerald-400",
  },
  error: {
    label: "Error",
    bg: "bg-red-500/15",
    text: "text-red-400",
    dot: "bg-red-400",
  },
  paused: {
    label: "Paused",
    bg: "bg-violet-500/15",
    text: "text-violet-400",
    dot: "bg-violet-400",
  },
};

export const SessionStatusBadge: Component<SessionStatusBadgeProps> = (
  props,
) => {
  const config = () => STATUS_CONFIG[props.status] ?? STATUS_CONFIG.idle;

  return (
    <span
      class={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${config().bg} ${config().text} ${props.class ?? ""}`}
    >
      <span
        class={`w-1.5 h-1.5 rounded-full ${config().dot} ${props.status === "running" ? "animate-pulse" : ""}`}
      />
      {config().label}
    </span>
  );
};
