// ABOUTME: Expandable card displaying a single validation step's result with details and artifacts.
// ABOUTME: Shows pass/fail status, duration, output preview, and attached screenshots/logs.

import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { ValidationStep } from "@/types/validation";

interface ValidationResultCardProps {
  step: ValidationStep;
  /** Index for display ordering (1-based). */
  index: number;
}

const EXECUTOR_LABELS: Record<string, string> = {
  terminal: "Terminal",
  artifact: "File Check",
  browser: "Browser",
  health_check: "Health Check",
};

export const ValidationResultCard: Component<ValidationResultCardProps> = (
  props,
) => {
  const [expanded, setExpanded] = createSignal(false);

  const statusIcon = () => {
    switch (props.step.status) {
      case "passed":
        return "\u2713";
      case "failed":
        return "\u2717";
      case "running":
        return "\u25CB";
      case "error":
        return "!";
      case "skipped":
        return "\u2014";
      default:
        return "\u00B7";
    }
  };

  const statusColor = () => {
    switch (props.step.status) {
      case "passed":
        return "text-success";
      case "failed":
      case "error":
        return "text-destructive";
      case "running":
        return "text-warning";
      default:
        return "text-muted-foreground";
    }
  };

  const borderColor = () => {
    switch (props.step.status) {
      case "passed":
        return "border-success/20";
      case "failed":
      case "error":
        return "border-destructive/20";
      case "running":
        return "border-warning/20";
      default:
        return "border-border";
    }
  };

  const formatDuration = (ms?: number) => {
    if (ms == null) return "";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const hasDetails = () =>
    props.step.result?.details ||
    props.step.result?.error ||
    (props.step.result?.artifacts?.length ?? 0) > 0;

  return (
    <div
      class={`rounded-lg border ${borderColor()} bg-surface-1/50 transition-all duration-150`}
    >
      {/* Header row — always visible */}
      <button
        type="button"
        class="flex items-center gap-3 w-full px-3 py-2.5 text-left cursor-pointer hover:bg-surface-2/30 rounded-lg transition-colors"
        onClick={() => hasDetails() && setExpanded((v) => !v)}
        disabled={!hasDetails()}
      >
        {/* Step number */}
        <span class="text-[0.7rem] text-muted-foreground w-4 text-right shrink-0">
          {props.index}
        </span>

        {/* Status icon */}
        <span
          class={`text-[0.9rem] w-5 text-center shrink-0 ${statusColor()} ${
            props.step.status === "running" ? "animate-spin" : ""
          }`}
        >
          {statusIcon()}
        </span>

        {/* Label and executor tag */}
        <div class="flex-1 min-w-0">
          <span class="text-[0.8rem] text-foreground truncate block">
            {props.step.label}
          </span>
        </div>

        {/* Executor tag */}
        <span class="text-[0.65rem] text-muted-foreground bg-surface-2 px-1.5 py-0.5 rounded shrink-0">
          {EXECUTOR_LABELS[props.step.executor] ?? props.step.executor}
        </span>

        {/* Duration */}
        <Show when={props.step.durationMs != null}>
          <span class="text-[0.65rem] text-muted-foreground shrink-0">
            {formatDuration(props.step.durationMs)}
          </span>
        </Show>

        {/* Expand indicator */}
        <Show when={hasDetails()}>
          <span
            class="text-[0.7rem] text-muted-foreground shrink-0 transition-transform duration-150"
            style={{ transform: expanded() ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            {"\u25B6"}
          </span>
        </Show>
      </button>

      {/* Expandable details */}
      <Show when={expanded() && hasDetails()}>
        <div class="px-3 pb-3 pt-0 border-t border-border/50">
          {/* Summary line */}
          <Show when={props.step.result?.summary}>
            <p class="text-[0.75rem] text-muted-foreground mt-2 mb-1">
              {props.step.result?.summary}
            </p>
          </Show>

          {/* Error message */}
          <Show when={props.step.result?.error}>
            <div class="mt-2 px-2.5 py-2 bg-destructive/5 border border-destructive/20 rounded text-[0.75rem] text-destructive/90 font-mono whitespace-pre-wrap break-all">
              {props.step.result?.error}
            </div>
          </Show>

          {/* Output details */}
          <Show when={props.step.result?.details}>
            <pre class="mt-2 px-2.5 py-2 bg-surface-0 border border-border rounded text-[0.7rem] text-muted-foreground font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {props.step.result?.details}
            </pre>
          </Show>

          {/* Artifacts */}
          <Show when={(props.step.result?.artifacts?.length ?? 0) > 0}>
            <div class="mt-2 flex flex-col gap-1.5">
              <span class="text-[0.7rem] text-muted-foreground font-medium">
                Artifacts
              </span>
              <For each={props.step.result?.artifacts}>
                {(artifact) => (
                  <div class="flex items-center gap-2 px-2 py-1.5 bg-surface-0 border border-border rounded text-[0.7rem]">
                    <span class="text-muted-foreground">
                      {artifact.type === "screenshot"
                        ? "\uD83D\uDCF7"
                        : artifact.type === "log"
                          ? "\uD83D\uDCC4"
                          : artifact.type === "trace"
                            ? "\uD83D\uDD0D"
                            : "\uD83D\uDCC1"}
                    </span>
                    <span class="text-foreground flex-1 truncate">
                      {artifact.label}
                    </span>
                    <span class="text-muted-foreground text-[0.6rem]">
                      {new Date(artifact.capturedAt).toLocaleTimeString()}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
