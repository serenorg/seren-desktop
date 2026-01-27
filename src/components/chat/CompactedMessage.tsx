// ABOUTME: Displays a compacted conversation summary at the top of the chat.
// ABOUTME: Shows collapsed older messages with expand option for full summary.

import type { Component } from "solid-js";
import { createSignal, Show } from "solid-js";
import type { CompactedSummary } from "@/stores/chat.store";

interface CompactedMessageProps {
  summary: CompactedSummary;
  onClear?: () => void;
}

export const CompactedMessage: Component<CompactedMessageProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false);

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <article class="mx-3 my-2 bg-[#1c2128] border border-[#30363d] rounded-lg overflow-hidden">
      <button
        type="button"
        class="w-full flex items-center justify-between px-3 py-2 bg-[#21262d] text-xs text-[#8b949e] cursor-pointer border-none hover:bg-[#30363d] transition-colors"
        onClick={() => setIsExpanded(!isExpanded())}
      >
        <div class="flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
            class={`transition-transform ${isExpanded() ? "rotate-90" : ""}`}
          >
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
          <span class="font-medium text-[#58a6ff]">
            {props.summary.originalMessageCount} messages compacted
          </span>
          <span class="text-[#484f58]">
            {formatDate(props.summary.compactedAt)}
          </span>
        </div>
        <Show when={props.onClear}>
          <button
            type="button"
            class="bg-transparent border border-[#30363d] text-[#8b949e] px-2 py-0.5 rounded text-xs cursor-pointer hover:bg-[#30363d] hover:text-[#e6edf3] transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              props.onClear?.();
            }}
          >
            Clear
          </button>
        </Show>
      </button>

      <Show when={isExpanded()}>
        <div class="px-3 py-2 text-sm text-[#e6edf3] leading-relaxed border-t border-[#30363d]">
          <div class="text-[10px] text-[#484f58] uppercase tracking-wide mb-2">
            Summary of previous conversation
          </div>
          <div class="whitespace-pre-wrap">{props.summary.content}</div>
        </div>
      </Show>
    </article>
  );
};
