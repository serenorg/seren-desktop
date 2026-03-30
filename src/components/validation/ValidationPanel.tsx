// ABOUTME: Collapsible validation panel displayed after agent task completion in the chat stream.
// ABOUTME: Shows validation plan, step progress, results, and overall pass/fail status.

import type { Component } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ValidationRun } from "@/types/validation";
import { ValidationResultCard } from "./ValidationResultCard";
import { ValidationStatusBadge } from "./ValidationStatusBadge";

interface ValidationPanelProps {
  run: ValidationRun;
  /** Callback to re-run validation from the UI. */
  onRerun?: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  code_edit: "Code Changes",
  ui_change: "UI Changes",
  browser_automation: "Browser Automation",
  deployment: "Deployment",
  file_generation: "File Generation",
  test_execution: "Test Execution",
  terminal_command: "Terminal Command",
  general: "General",
};

export const ValidationPanel: Component<ValidationPanelProps> = (props) => {
  const [expanded, setExpanded] = createSignal(true);

  const progress = createMemo(() => {
    const steps = props.run.steps;
    const done = steps.filter(
      (s) =>
        s.status === "passed" ||
        s.status === "failed" ||
        s.status === "skipped" ||
        s.status === "error",
    ).length;
    return { done, total: steps.length };
  });

  const passedCount = createMemo(
    () => props.run.steps.filter((s) => s.status === "passed").length,
  );

  const failedCount = createMemo(
    () =>
      props.run.steps.filter(
        (s) => s.status === "failed" || s.status === "error",
      ).length,
  );

  const isTerminal = () =>
    props.run.status === "passed" ||
    props.run.status === "failed" ||
    props.run.status === "skipped" ||
    props.run.status === "error";

  const formatDuration = (ms?: number) => {
    if (ms == null) return "";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const panelBorder = () => {
    switch (props.run.status) {
      case "passed":
        return "border-success/25";
      case "failed":
      case "error":
        return "border-destructive/25";
      case "running":
      case "repairing":
        return "border-warning/25";
      default:
        return "border-border";
    }
  };

  const headerGlow = () => {
    switch (props.run.status) {
      case "passed":
        return "shadow-[0_0_12px_rgba(52,211,153,0.08)]";
      case "failed":
      case "error":
        return "shadow-[0_0_12px_rgba(248,113,113,0.08)]";
      default:
        return "";
    }
  };

  return (
    <div
      class={`validation-panel rounded-xl border ${panelBorder()} bg-surface-1/60 backdrop-blur-sm overflow-hidden transition-all duration-200 ${headerGlow()}`}
      data-testid="validation-panel"
      data-status={props.run.status}
    >
      {/* Header */}
      <button
        type="button"
        class="flex items-center gap-3 w-full px-4 py-3 text-left cursor-pointer hover:bg-surface-2/20 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        data-testid="validation-panel-header"
      >
        {/* Left: icon and title */}
        <div class="flex items-center gap-2.5 flex-1 min-w-0">
          <span class="text-[1.1rem]" aria-hidden="true">
            {props.run.status === "passed"
              ? "\uD83D\uDEE1\uFE0F"
              : props.run.status === "failed" || props.run.status === "error"
                ? "\u26A0\uFE0F"
                : props.run.status === "running" ||
                    props.run.status === "repairing"
                  ? "\uD83D\uDD04"
                  : "\uD83D\uDCCB"}
          </span>
          <div class="flex flex-col min-w-0">
            <span class="text-[0.85rem] font-semibold text-foreground">
              Self-Test
            </span>
            <span class="text-[0.7rem] text-muted-foreground truncate">
              {CATEGORY_LABELS[props.run.taskCategory] ??
                props.run.taskCategory}
              <Show when={props.run.repairIteration > 0}>
                {" \u00B7 "}Repair #{props.run.repairIteration}
              </Show>
            </span>
          </div>
        </div>

        {/* Center: status badge */}
        <ValidationStatusBadge
          status={props.run.status}
          progress={progress()}
        />

        {/* Right: stats and duration */}
        <div class="flex items-center gap-3">
          <Show when={isTerminal() && props.run.steps.length > 0}>
            <div class="flex items-center gap-1.5 text-[0.7rem]">
              <Show when={passedCount() > 0}>
                <span class="text-success">{passedCount()} passed</span>
              </Show>
              <Show when={failedCount() > 0}>
                <span class="text-destructive">{failedCount()} failed</span>
              </Show>
            </div>
          </Show>

          <Show when={props.run.durationMs != null}>
            <span class="text-[0.65rem] text-muted-foreground">
              {formatDuration(props.run.durationMs)}
            </span>
          </Show>

          <span
            class="text-[0.7rem] text-muted-foreground transition-transform duration-150"
            style={{ transform: expanded() ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            {"\u25B6"}
          </span>
        </div>
      </button>

      {/* Body — expandable */}
      <Show when={expanded()}>
        <div class="px-4 pb-4 flex flex-col gap-2 border-t border-border/50">
          {/* Summary */}
          <Show when={props.run.summary}>
            <p
              class={`text-[0.75rem] mt-3 mb-1 ${
                props.run.status === "passed"
                  ? "text-success/80"
                  : props.run.status === "failed" ||
                      props.run.status === "error"
                    ? "text-destructive/80"
                    : "text-muted-foreground"
              }`}
            >
              {props.run.summary}
            </p>
          </Show>

          {/* Steps list */}
          <Show when={props.run.steps.length > 0}>
            <div class="flex flex-col gap-1.5 mt-1">
              <For each={props.run.steps}>
                {(step, index) => (
                  <ValidationResultCard step={step} index={index() + 1} />
                )}
              </For>
            </div>
          </Show>

          {/* Re-run button */}
          <Show when={isTerminal() && props.onRerun}>
            <div class="flex justify-end mt-2">
              <button
                type="button"
                class="text-[0.7rem] px-3 py-1.5 rounded-md bg-surface-2 hover:bg-surface-3 text-muted-foreground hover:text-foreground border border-border transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onRerun?.();
                }}
                data-testid="validation-rerun-btn"
              >
                Re-run Validation
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
