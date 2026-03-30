// ABOUTME: Inline status badge showing validation state (passed, failed, running, skipped).
// ABOUTME: Used in chat messages and thread headers to surface validation outcome at a glance.

import type { Component } from "solid-js";
import { Show } from "solid-js";
import type { ValidationRunStatus } from "@/types/validation";

interface ValidationStatusBadgeProps {
  status: ValidationRunStatus;
  /** Optional: number of steps completed / total. */
  progress?: { done: number; total: number };
  /** Compact mode for inline use. */
  compact?: boolean;
}

const STATUS_CONFIG: Record<
  ValidationRunStatus,
  { label: string; icon: string; colorClass: string; bgClass: string }
> = {
  planning: {
    label: "Planning",
    icon: "\u2699",
    colorClass: "text-muted-foreground",
    bgClass: "bg-surface-2",
  },
  running: {
    label: "Validating",
    icon: "\u25CB",
    colorClass: "text-warning",
    bgClass: "bg-warning/10",
  },
  passed: {
    label: "Validated",
    icon: "\u2713",
    colorClass: "text-success",
    bgClass: "bg-success/10",
  },
  failed: {
    label: "Failed",
    icon: "\u2717",
    colorClass: "text-destructive",
    bgClass: "bg-destructive/10",
  },
  repairing: {
    label: "Repairing",
    icon: "\u21BB",
    colorClass: "text-warning",
    bgClass: "bg-warning/10",
  },
  skipped: {
    label: "Unvalidated",
    icon: "\u2014",
    colorClass: "text-muted-foreground",
    bgClass: "bg-surface-2",
  },
  error: {
    label: "Error",
    icon: "!",
    colorClass: "text-destructive",
    bgClass: "bg-destructive/10",
  },
};

export const ValidationStatusBadge: Component<ValidationStatusBadgeProps> = (
  props,
) => {
  const config = () => STATUS_CONFIG[props.status];

  return (
    <span
      class={`inline-flex items-center gap-1.5 font-medium select-none transition-colors duration-150 ${config().colorClass} ${config().bgClass} ${
        props.compact
          ? "text-[0.7rem] px-1.5 py-0.5 rounded"
          : "text-[0.75rem] px-2 py-1 rounded-md"
      }`}
      title={`Validation: ${config().label}`}
    >
      <span
        class={`${props.status === "running" || props.status === "repairing" ? "animate-spin" : ""}`}
        aria-hidden="true"
      >
        {config().icon}
      </span>
      <span>{config().label}</span>
      <Show when={props.progress && props.status === "running"}>
        <span class="text-[0.65rem] opacity-70">
          {props.progress?.done}/{props.progress?.total}
        </span>
      </Show>
    </span>
  );
};
