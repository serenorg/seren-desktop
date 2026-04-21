// ABOUTME: Displays a compacted conversation summary at the top of the chat.
// ABOUTME: Shows collapsed older messages with expand option for full summary + original scrollback.

import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type { CompactedSummary } from "@/stores/chat.store";

interface CompactedMessageProps {
  summary: CompactedSummary;
  onClear?: () => void;
}

export const CompactedMessage: Component<CompactedMessageProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false);
  const [showScrollback, setShowScrollback] = createSignal(false);

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatTime = (timestamp: number): string =>
    new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });

  const scrollback = () => props.summary.preCompactionMessages ?? [];

  return (
    <article class="mx-3 my-2 bg-surface-1 border border-surface-3 rounded-lg overflow-hidden">
      <button
        type="button"
        class="w-full flex items-center justify-between px-3 py-2 bg-surface-2 text-xs text-muted-foreground cursor-pointer border-none hover:bg-surface-3 transition-colors"
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
          <span class="font-medium text-primary">
            {props.summary.originalMessageCount} messages compacted
          </span>
          <span class="text-muted-foreground/70">
            {formatDate(props.summary.compactedAt)}
          </span>
        </div>
        <Show when={props.onClear}>
          <button
            type="button"
            class="bg-transparent border border-surface-3 text-muted-foreground px-2 py-0.5 rounded text-xs cursor-pointer hover:bg-surface-3 hover:text-foreground transition-colors"
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
        <div class="px-3 py-2 text-sm text-foreground leading-relaxed border-t border-surface-3">
          <div class="text-[10px] text-muted-foreground/70 uppercase tracking-wide mb-2">
            Summary of previous conversation
          </div>
          <div class="whitespace-pre-wrap">{props.summary.content}</div>

          <Show when={scrollback().length > 0}>
            <button
              type="button"
              class="mt-3 flex items-center gap-1.5 bg-transparent border border-surface-3 text-muted-foreground px-2 py-1 rounded text-xs cursor-pointer hover:bg-surface-3 hover:text-foreground transition-colors"
              onClick={() => setShowScrollback(!showScrollback())}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                class={`transition-transform ${
                  showScrollback() ? "rotate-90" : ""
                }`}
              >
                <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
              {showScrollback() ? "Hide" : "Show"} {scrollback().length}{" "}
              original
              {scrollback().length === 1 ? " message" : " messages"}
            </button>

            <Show when={showScrollback()}>
              <div class="mt-3 flex flex-col gap-3 border-t border-surface-3 pt-3">
                <For each={scrollback()}>
                  {(msg) => (
                    <div class="flex flex-col gap-0.5">
                      <div class="text-[10px] uppercase tracking-wide text-muted-foreground/70 flex items-center gap-2">
                        <span
                          class={
                            msg.type === "user"
                              ? "text-primary"
                              : "text-foreground"
                          }
                        >
                          {msg.type === "user" ? "You" : "Assistant"}
                        </span>
                        <span class="text-muted-foreground/50">
                          {formatTime(msg.timestamp)}
                        </span>
                      </div>
                      <div class="whitespace-pre-wrap text-foreground/90 text-sm">
                        {msg.content}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </article>
  );
};
