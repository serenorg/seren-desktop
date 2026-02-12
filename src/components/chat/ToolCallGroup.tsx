// ABOUTME: Groups multiple tool calls into a collapsible summary with plain language description.
// ABOUTME: Reduces clutter by showing "searched 5 files, ran 3 commands" instead of 20+ individual cards.

import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { ToolCallEvent } from "@/services/acp";
import { ToolCallCard } from "./ToolCallCard";

interface ToolCallGroupProps {
  toolCalls: ToolCallEvent[];
  isComplete?: boolean;
}

/** Categorize tool calls into plain language summary */
function categorizeToolCalls(toolCalls: ToolCallEvent[]) {
  const categories = {
    filesSearched: 0,
    filesEdited: 0,
    filesWritten: 0,
    commandsRun: 0,
    tasksCreated: 0,
    other: 0,
  };

  for (const tool of toolCalls) {
    const kind = tool.kind.toLowerCase();
    const title = tool.title.toLowerCase();

    if (kind === "read" || kind.includes("file") || kind === "glob" || kind === "grep") {
      categories.filesSearched++;
    } else if (kind === "edit") {
      categories.filesEdited++;
    } else if (kind === "write" || kind === "notebookedit") {
      categories.filesWritten++;
    } else if (kind.includes("bash") || kind.includes("command") || kind === "execute") {
      categories.commandsRun++;
    } else if (title.includes("todo") || kind === "todowrite") {
      categories.tasksCreated++;
    } else {
      categories.other++;
    }
  }

  return categories;
}

/** Build plain language summary from categories */
function buildSummary(categories: ReturnType<typeof categorizeToolCalls>): string {
  const parts: string[] = [];

  if (categories.filesSearched > 0) {
    parts.push(`searched ${categories.filesSearched} file${categories.filesSearched > 1 ? "s" : ""}`);
  }
  if (categories.filesEdited > 0) {
    parts.push(`edited ${categories.filesEdited} file${categories.filesEdited > 1 ? "s" : ""}`);
  }
  if (categories.filesWritten > 0) {
    parts.push(`created ${categories.filesWritten} file${categories.filesWritten > 1 ? "s" : ""}`);
  }
  if (categories.commandsRun > 0) {
    parts.push(`ran ${categories.commandsRun} command${categories.commandsRun > 1 ? "s" : ""}`);
  }
  if (categories.tasksCreated > 0) {
    parts.push("updated task list");
  }
  if (categories.other > 0 && parts.length === 0) {
    parts.push(`${categories.other} operation${categories.other > 1 ? "s" : ""}`);
  }

  if (parts.length === 0) return "No operations";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;

  // Join with commas and "and" for the last item
  const lastPart = parts.pop();
  return `${parts.join(", ")}, and ${lastPart}`;
}

export const ToolCallGroup: Component<ToolCallGroupProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false);

  const categories = () => categorizeToolCalls(props.toolCalls);
  const summary = () => buildSummary(categories());
  const hasRunning = () => props.toolCalls.some((t) => t.status.toLowerCase().includes("running"));

  return (
    <div class="my-2 mx-5 bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
      {/* Collapsible Header */}
      <button
        type="button"
        class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[#21262d] transition-colors"
        onClick={() => setIsExpanded(!isExpanded())}
      >
        {/* Status Icon */}
        <Show
          when={hasRunning()}
          fallback={
            <svg
              class="w-4 h-4 shrink-0 text-green-500"
              fill="currentColor"
              viewBox="0 0 20 20"
              role="img"
              aria-label="Complete"
            >
              <path
                fill-rule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clip-rule="evenodd"
              />
            </svg>
          }
        >
          <svg
            class="w-4 h-4 shrink-0 text-yellow-500 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            role="img"
            aria-label="Working"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </Show>

        {/* Summary Text */}
        <span class="flex-1 text-sm text-[#e6edf3]">
          <Show when={hasRunning()} fallback={`Done (${summary()})`}>
            Working on your request... ({summary()})
          </Show>
        </span>

        {/* Tool Count Badge */}
        <span class="shrink-0 px-2 py-0.5 rounded text-xs bg-[#30363d] text-[#8b949e]">
          {props.toolCalls.length} tool{props.toolCalls.length > 1 ? "s" : ""}
        </span>

        {/* Expand Icon */}
        <svg
          class={`w-4 h-4 shrink-0 text-[#8b949e] transition-transform ${isExpanded() ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          role="img"
          aria-label={isExpanded() ? "Collapse" : "Expand"}
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Expanded Tool Call Cards */}
      <Show when={isExpanded()}>
        <div class="border-t border-[#21262d] px-3 py-2 space-y-2">
          <For each={props.toolCalls}>
            {(toolCall) => <ToolCallCard toolCall={toolCall} />}
          </For>
        </div>
      </Show>
    </div>
  );
};
