// ABOUTME: Displays the agent's plan entries in a collapsible header.
// ABOUTME: Shows plan progress with status indicators for each entry.

import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { acpStore } from "@/stores/acp.store";

export const PlanHeader: Component = () => {
  const [isExpanded, setIsExpanded] = createSignal(true);
  const plan = () => acpStore.plan;
  const hasPlan = () => plan().length > 0;

  const getStatusIcon = (status: string) => {
    switch (status.toLowerCase()) {
      case "completed":
        return (
          <svg
            class="w-4 h-4 text-green-500"
            fill="currentColor"
            viewBox="0 0 20 20"
            role="img"
            aria-label="Completed"
          >
            <path
              fill-rule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clip-rule="evenodd"
            />
          </svg>
        );
      case "inprogress":
      case "in_progress":
        return (
          <svg
            class="w-4 h-4 text-yellow-500 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            role="img"
            aria-label="In progress"
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
        );
      case "pending":
        return (
          <span class="w-4 h-4 flex items-center justify-center">
            <span class="w-2 h-2 rounded-full bg-muted-foreground" />
          </span>
        );
      default:
        return (
          <span class="w-4 h-4 flex items-center justify-center">
            <span class="w-2 h-2 rounded-full bg-surface-3" />
          </span>
        );
    }
  };

  const completedCount = () =>
    plan().filter((e) => e.status.toLowerCase() === "completed").length;
  const totalCount = () => plan().length;

  return (
    <Show when={hasPlan()}>
      <div class="bg-surface-0 border-b border-surface-2">
        {/* Header */}
        <button
          type="button"
          class="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-surface-2 transition-colors"
          onClick={() => setIsExpanded(!isExpanded())}
        >
          <div class="flex items-center gap-2">
            <svg
              class={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded() ? "rotate-90" : ""}`}
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
                d="M9 5l7 7-7 7"
              />
            </svg>
            <span class="text-sm font-medium text-foreground">Plan</span>
          </div>
          <span class="text-xs text-muted-foreground">
            {completedCount()}/{totalCount()} completed
          </span>
        </button>

        {/* Plan Entries */}
        <Show when={isExpanded()}>
          <div class="px-4 pb-3">
            <ol class="m-0 p-0 list-none space-y-1">
              <For each={plan()}>
                {(entry, index) => (
                  <li class="flex items-start gap-2 text-sm">
                    <span class="flex-shrink-0 mt-0.5">
                      {getStatusIcon(entry.status)}
                    </span>
                    <span
                      class={`${
                        entry.status.toLowerCase() === "completed"
                          ? "text-muted-foreground line-through"
                          : entry.status.toLowerCase().includes("progress")
                            ? "text-foreground font-medium"
                            : "text-muted-foreground"
                      }`}
                    >
                      <span class="text-muted-foreground/70 mr-1.5">
                        {index() + 1}.
                      </span>
                      {entry.content}
                    </span>
                  </li>
                )}
              </For>
            </ol>
          </div>
        </Show>
      </div>
    </Show>
  );
};
