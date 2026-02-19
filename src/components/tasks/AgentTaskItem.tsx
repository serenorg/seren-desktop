// ABOUTME: Compact row component for a single agent task in the task list.
// ABOUTME: Shows status, publisher, timing, cost, and expandable output.

import {
  type Component,
  createEffect,
  createSignal,
  For,
  Show,
} from "solid-js";
import type { AgentTask } from "@/services/agent-tasks";
import { isTerminalStatus } from "@/services/agent-tasks";
import type { StreamEvent } from "@/stores/agent-tasks.store";
import { TaskStatusBadge } from "./TaskStatusBadge";

interface AgentTaskItemProps {
  task: AgentTask;
  isActive: boolean;
  events: StreamEvent[];
  onSelect: (taskId: string) => void;
  onCancel: (taskId: string) => void;
}

function formatCost(atomic: number): string {
  if (atomic === 0) return "free";
  const dollars = atomic / 1_000_000;
  if (dollars < 0.01) return `<$0.01`;
  return `$${dollars.toFixed(2)}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function duration(start?: string, end?: string): string {
  if (!start) return "";
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const ms = endMs - startMs;
  if (ms < 1000) return `${ms}ms`;
  const secs = (ms / 1000).toFixed(1);
  return `${secs}s`;
}

function eventLabel(eventType: string): string {
  const map: Record<string, string> = {
    "task.created": "Created",
    "task.submitted": "Submitted",
    "task.working": "Working",
    "task.completed": "Completed",
    "task.failed": "Failed",
    "task.canceled": "Canceled",
    "task.input_required": "Input Required",
    "task.progress": "Progress",
    "task.artifact": "Artifact",
  };
  return map[eventType] ?? eventType;
}

function eventSummary(data: Record<string, unknown>): string {
  if (typeof data.message === "string") return data.message;
  if (typeof data.text === "string") return data.text;
  if (data.status) return `Status → ${data.status}`;
  return JSON.stringify(data).slice(0, 120);
}

export const AgentTaskItem: Component<AgentTaskItemProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  let logRef: HTMLDivElement | undefined;

  const isTerminal = () => isTerminalStatus(props.task.status);

  // Auto-scroll event log when new events arrive
  createEffect(() => {
    const count = props.events.length;
    if (count > 0 && logRef) {
      requestAnimationFrame(() => {
        if (logRef) logRef.scrollTop = logRef.scrollHeight;
      });
    }
  });

  return (
    <div
      class={`group border-b border-border/50 transition-colors cursor-pointer ${
        props.isActive
          ? "bg-primary/[0.08] border-l-2 border-l-primary"
          : "hover:bg-surface-1 border-l-2 border-l-transparent"
      }`}
      onClick={() => props.onSelect(props.task.id)}
    >
      {/* Main Row */}
      <div class="flex items-center gap-3 px-3 py-2.5">
        {/* Status + Info */}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <TaskStatusBadge status={props.task.status} />
            <span class="text-[11px] text-muted-foreground font-mono truncate">
              {props.task.id.slice(0, 8)}
            </span>
          </div>
          <div class="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span class="truncate max-w-[140px]">
              {props.task.publisher_id.slice(0, 12)}
            </span>
            <span class="text-surface-3">|</span>
            <span>{timeAgo(props.task.created_at)}</span>
            <Show when={props.task.started_at}>
              <span class="text-surface-3">|</span>
              <span>
                {duration(props.task.started_at, props.task.completed_at)}
              </span>
            </Show>
          </div>
        </div>

        {/* Right Side: Cost + Actions */}
        <div class="flex items-center gap-2 shrink-0">
          <Show when={props.task.cost_total_atomic > 0}>
            <span class="text-[11px] font-mono text-emerald-400/80">
              {formatCost(props.task.cost_total_atomic)}
            </span>
          </Show>

          <Show when={!isTerminal()}>
            <button
              type="button"
              class="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-[10px] text-red-400 border border-red-400/30 rounded hover:bg-red-400/10 transition-all"
              onClick={(e) => {
                e.stopPropagation();
                props.onCancel(props.task.id);
              }}
            >
              Cancel
            </button>
          </Show>

          {/* Expand toggle */}
          <button
            type="button"
            class="p-1 text-muted-foreground hover:text-foreground transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            <svg
              class={`w-3 h-3 transition-transform ${expanded() ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <title>Expand details</title>
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Expanded Detail */}
      <Show when={expanded()}>
        <div class="px-3 pb-3 pt-0 border-t border-border/30">
          {/* Live Event Log */}
          <Show when={props.events.length > 0}>
            <div class="mt-2">
              <div class="text-[11px] text-muted-foreground mb-1 font-medium uppercase tracking-wider flex items-center gap-1.5">
                Events
                <Show when={!isTerminal()}>
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                </Show>
                <span class="text-[10px] font-normal normal-case text-muted-foreground/60 ml-auto">
                  {props.events.length}
                </span>
              </div>
              <div
                ref={logRef}
                class="bg-surface-0 border border-border/50 rounded max-h-[160px] overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-surface-3 [&::-webkit-scrollbar-thumb]:rounded"
              >
                <For each={props.events}>
                  {(evt) => (
                    <div class="flex items-start gap-2 px-2 py-1 border-b border-border/20 last:border-b-0 text-[11px]">
                      <span class="shrink-0 font-mono text-primary/70 min-w-[70px]">
                        {eventLabel(evt.eventType)}
                      </span>
                      <span class="text-foreground/70 break-all leading-relaxed">
                        {eventSummary(evt.data)}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Cost Breakdown */}
          <Show
            when={
              props.task.cost_compute_atomic > 0 ||
              props.task.cost_llm_atomic > 0 ||
              props.task.cost_tool_atomic > 0
            }
          >
            <div class="flex gap-3 mt-2 text-[11px] text-muted-foreground">
              <span>
                Compute:{" "}
                <span class="text-foreground/70">
                  {formatCost(props.task.cost_compute_atomic)}
                </span>
              </span>
              <span>
                LLM:{" "}
                <span class="text-foreground/70">
                  {formatCost(props.task.cost_llm_atomic)}
                </span>
              </span>
              <span>
                Tools:{" "}
                <span class="text-foreground/70">
                  {formatCost(props.task.cost_tool_atomic)}
                </span>
              </span>
            </div>
          </Show>

          {/* Output */}
          <Show when={props.task.output}>
            <div class="mt-2">
              <div class="text-[11px] text-muted-foreground mb-1 font-medium uppercase tracking-wider">
                Output
              </div>
              <pre class="text-[12px] text-foreground/80 bg-surface-0 border border-border/50 rounded p-2 overflow-x-auto max-h-[200px] overflow-y-auto font-mono leading-relaxed">
                {JSON.stringify(props.task.output, null, 2)}
              </pre>
            </div>
          </Show>

          {/* Error */}
          <Show when={props.task.error_message}>
            <div class="mt-2">
              <div class="text-[11px] text-red-400 mb-1 font-medium uppercase tracking-wider">
                Error
              </div>
              <pre class="text-[12px] text-red-300/80 bg-red-950/20 border border-red-400/20 rounded p-2 overflow-x-auto max-h-[120px] overflow-y-auto font-mono leading-relaxed">
                {props.task.error_message}
              </pre>
            </div>
          </Show>

          {/* Input */}
          <div class="mt-2">
            <div class="text-[11px] text-muted-foreground mb-1 font-medium uppercase tracking-wider">
              Input
            </div>
            <pre class="text-[12px] text-foreground/60 bg-surface-0 border border-border/50 rounded p-2 overflow-x-auto max-h-[120px] overflow-y-auto font-mono leading-relaxed">
              {JSON.stringify(props.task.input_message, null, 2)}
            </pre>
          </div>
        </div>
      </Show>
    </div>
  );
};
