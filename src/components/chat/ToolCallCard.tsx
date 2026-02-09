// ABOUTME: Card component for displaying agent tool calls and their status.
// ABOUTME: Shows tool name, status indicator, and expandable details.

import type { Component } from "solid-js";
import { createSignal, Show } from "solid-js";
import type { ToolCallEvent } from "@/services/acp";

interface ToolCallCardProps {
  toolCall: ToolCallEvent;
}

export const ToolCallCard: Component<ToolCallCardProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false);

  const statusInfo = () => {
    const status = props.toolCall.status.toLowerCase();
    if (status.includes("running") || status.includes("progress")) {
      return {
        color: "text-yellow-500",
        bg: "bg-yellow-500/20",
        icon: (
          <svg
            class="w-4 h-4 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
            role="img"
            aria-label="Running"
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
        ),
        label: "Running",
      };
    }
    if (status.includes("complete") || status.includes("success")) {
      return {
        color: "text-green-500",
        bg: "bg-green-500/20",
        icon: (
          <svg
            class="w-4 h-4"
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
        ),
        label: "Completed",
      };
    }
    if (status.includes("error") || status.includes("fail")) {
      return {
        color: "text-red-500",
        bg: "bg-red-500/20",
        icon: (
          <svg
            class="w-4 h-4"
            fill="currentColor"
            viewBox="0 0 20 20"
            role="img"
            aria-label="Failed"
          >
            <path
              fill-rule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clip-rule="evenodd"
            />
          </svg>
        ),
        label: "Failed",
      };
    }
    return {
      color: "text-[#8b949e]",
      bg: "bg-[#30363d]",
      icon: (
        <span class="w-4 h-4 flex items-center justify-center">
          <span class="w-2 h-2 rounded-full bg-current" />
        </span>
      ),
      label: "Pending",
    };
  };

  const toolIcon = () => {
    const kind = props.toolCall.kind.toLowerCase();
    if (kind.includes("read") || kind.includes("file")) {
      return (
        <svg
          class="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          role="img"
          aria-label="File"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      );
    }
    if (kind.includes("write") || kind.includes("edit")) {
      return (
        <svg
          class="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          role="img"
          aria-label="Edit"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
      );
    }
    if (
      kind.includes("bash") ||
      kind.includes("terminal") ||
      kind.includes("command")
    ) {
      return (
        <svg
          class="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          role="img"
          aria-label="Terminal"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      );
    }
    if (
      kind.includes("search") ||
      kind.includes("grep") ||
      kind.includes("glob")
    ) {
      return (
        <svg
          class="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          role="img"
          aria-label="Search"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      );
    }
    // Default tool icon
    return (
      <svg
        class="w-4 h-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        role="img"
        aria-label="Tool"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    );
  };

  return (
    <div class="my-2 bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
      {/* Header */}
      <button
        type="button"
        class="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-[#21262d] transition-colors"
        onClick={() => setIsExpanded(!isExpanded())}
      >
        {/* Tool Icon */}
        <span class="text-[#8b949e]">{toolIcon()}</span>

        {/* Title */}
        <span class="flex-1 text-sm text-[#e6edf3] truncate">
          {props.toolCall.title}
        </span>

        {/* Status Badge */}
        <span
          class={`flex items-center gap-1 px-2 py-0.5 rounded text-xs ${statusInfo().color} ${statusInfo().bg}`}
        >
          {statusInfo().icon}
          <span>{statusInfo().label}</span>
        </span>

        {/* Expand Icon */}
        <svg
          class={`w-4 h-4 text-[#8b949e] transition-transform ${isExpanded() ? "rotate-180" : ""}`}
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

      {/* Details */}
      <Show when={isExpanded()}>
        <div class="px-3 py-2 border-t border-[#21262d] text-xs">
          {/* Parameters */}
          <Show when={props.toolCall.parameters}>
            <div class="mb-3">
              <div class="text-[#484f58] font-medium mb-1">Parameters:</div>
              <div class="bg-[#0d1117] border border-[#30363d] rounded p-2 font-mono text-[#e6edf3]">
                {Object.entries(props.toolCall.parameters!).map(([key, value]) => (
                  <div class="mb-1 last:mb-0">
                    <span class="text-[#79c0ff]">{key}:</span>{" "}
                    <span class="text-[#a5d6ff]">
                      {typeof value === "string" ? value : JSON.stringify(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Show>

          {/* Result */}
          <Show when={props.toolCall.result}>
            <div class="mb-3">
              <div class="text-[#484f58] font-medium mb-1">Result:</div>
              <div class="bg-[#0d1117] border border-[#238636] rounded p-2 text-[#3fb950]">
                {props.toolCall.result}
              </div>
            </div>
          </Show>

          {/* Error */}
          <Show when={props.toolCall.error}>
            <div class="mb-3">
              <div class="text-[#484f58] font-medium mb-1">Error:</div>
              <div class="bg-[#0d1117] border border-[#f85149] rounded p-2 text-[#f85149]">
                {props.toolCall.error}
              </div>
            </div>
          </Show>

          {/* Metadata */}
          <div class="grid grid-cols-2 gap-2 text-[#8b949e]">
            <div>
              <span class="text-[#484f58]">Kind:</span>{" "}
              <span class="text-[#e6edf3]">{props.toolCall.kind}</span>
            </div>
            <div>
              <span class="text-[#484f58]">ID:</span>{" "}
              <span class="font-mono">
                {props.toolCall.toolCallId.slice(0, 8)}...
              </span>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};
