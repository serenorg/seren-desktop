/* eslint-disable solid/no-innerhtml */
// ABOUTME: Streaming message component with tool execution display.
// ABOUTME: Shows tool calls being executed and their results during chat.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatToolResultText } from "@/lib/format-tool-result";
import type { ToolCall, ToolResult } from "@/lib/providers/types";
import { renderMarkdown } from "@/lib/render-markdown";
import type { ToolIterationState, ToolStreamEvent } from "@/services/chat";
import { settingsStore } from "@/stores/settings.store";
import { ThinkingBlock } from "./ThinkingBlock";

interface ToolStreamingMessageProps {
  stream: AsyncGenerator<ToolStreamEvent>;
  onComplete: (fullContent: string, thinking?: string) => void;
  onError?: (error: Error) => void;
  onContentUpdate?: () => void;
  onIterationLimit?: (
    state: ToolIterationState,
    iteration: number,
  ) => AsyncGenerator<ToolStreamEvent> | undefined;
}

interface ToolExecution {
  call: ToolCall;
  result?: ToolResult;
  status: "pending" | "complete" | "error";
}

export const ToolStreamingMessage: Component<ToolStreamingMessageProps> = (
  props,
) => {
  const [content, setContent] = createSignal("");
  const [thinking, setThinking] = createSignal("");
  const [toolExecutions, setToolExecutions] = createSignal<ToolExecution[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(true);
  let isCancelled = false;

  const consume = async () => {
    let fullContent = "";
    let fullThinking = "";
    let hadError = false;
    let currentStream: AsyncGenerator<ToolStreamEvent> = props.stream;

    try {
      let shouldContinue = true;
      while (shouldContinue) {
        shouldContinue = false;

        streamLoop: for await (const event of currentStream) {
          if (isCancelled) break;

          switch (event.type) {
            case "content":
              fullContent += event.content;
              setContent(fullContent);
              props.onContentUpdate?.();
              break;

            case "thinking":
              fullThinking += event.thinking;
              setThinking(fullThinking);
              props.onContentUpdate?.();
              break;

            case "tool_calls":
              // Add new tool executions in pending state
              setToolExecutions((prev) => [
                ...prev,
                ...event.toolCalls.map((call) => ({
                  call,
                  status: "pending" as const,
                })),
              ]);
              props.onContentUpdate?.();
              break;

            case "tool_results":
              // Update tool executions with results
              setToolExecutions((prev) =>
                prev.map((exec) => {
                  const result = event.results.find(
                    (r) => r.tool_call_id === exec.call.id,
                  );
                  if (result) {
                    return {
                      ...exec,
                      result,
                      status: result.is_error ? "error" : "complete",
                    };
                  }
                  return exec;
                }),
              );
              props.onContentUpdate?.();
              break;

            case "complete":
              fullContent = event.finalContent;
              setContent(fullContent);
              if (event.finalThinking) {
                fullThinking = event.finalThinking;
                setThinking(fullThinking);
              }
              break;

            case "iteration_limit": {
              // Ask parent for a continuation generator
              const continuation = props.onIterationLimit?.(
                event.continueState,
                event.currentIteration,
              );
              if (continuation) {
                console.log(
                  "[ToolStreamingMessage] Auto-continuing after iteration",
                  event.currentIteration,
                );
                currentStream = continuation;
                shouldContinue = true;
                break streamLoop;
              }
              // No continuation handler — stop streaming
              setIsStreaming(false);
              return;
            }
          }
        }
      }
    } catch (error) {
      hadError = true;
      props.onError?.(error as Error);
    } finally {
      setIsStreaming(false);
      if (!isCancelled && !hadError) {
        let finalContent = fullContent;
        const executions = toolExecutions();

        // When text content is empty but tool operations occurred,
        // generate a summary so the message isn't invisible after streaming ends
        if (!finalContent.trim() && executions.length > 0) {
          console.warn(
            "[ToolStreamingMessage] Empty content with",
            executions.length,
            "tool executions — generating summary",
          );
          const lines = executions.map((exec) => {
            const icon = exec.status === "error" ? "❌" : "✓";
            const name = exec.call.function.name;
            let detail = "";
            if (exec.result?.is_error && exec.result.content) {
              detail = ` — ${exec.result.content.substring(0, 200)}`;
            }
            return `- ${icon} **${name}**${detail}`;
          });
          finalContent = `*Tool operations completed:*\n\n${lines.join("\n")}`;
        }

        props.onComplete(finalContent, fullThinking || undefined);
      }
    }
  };

  onMount(() => {
    void consume();
  });

  onCleanup(() => {
    isCancelled = true;
    void props.stream.return?.(undefined);
  });

  const formatToolArgs = (argsJson: string): string => {
    try {
      const args = JSON.parse(argsJson);
      // Show just the path for file operations
      if (args.path) return args.path;
      return Object.values(args).join(", ");
    } catch {
      return argsJson;
    }
  };

  const getStatusClasses = (status: string) => {
    const base = "px-2 py-1.5 mb-1 last:mb-0 bg-[rgba(0,0,0,0.2)] rounded";
    if (status === "pending") return `${base} opacity-80`;
    if (status === "error") return `${base} border-l-[3px] border-[#f85149]`;
    if (status === "complete") return `${base} border-l-[3px] border-[#3fb950]`;
    return base;
  };

  return (
    <article class="px-4 py-4 border-b border-[#21262d] bg-transparent">
      {/* Thinking block */}
      <Show when={thinking() && settingsStore.get("chatShowThinking")}>
        <ThinkingBlock thinking={thinking()} isStreaming={isStreaming()} />
      </Show>

      {/* Tool executions */}
      <Show when={toolExecutions().length > 0}>
        <div class="mb-3 p-2 bg-[rgba(88,166,255,0.05)] border border-[rgba(88,166,255,0.2)] rounded-md">
          <For each={toolExecutions()}>
            {(exec) => (
              <div class={getStatusClasses(exec.status)}>
                <div class="flex items-center gap-2 text-[13px]">
                  <span
                    class={`text-sm w-[18px] text-center ${exec.status === "pending" ? "animate-[pulse_1.5s_infinite]" : ""}`}
                  >
                    {exec.status === "pending"
                      ? "⏳"
                      : exec.status === "error"
                        ? "❌"
                        : "✓"}
                  </span>
                  <span class="font-medium text-[#58a6ff]">
                    {exec.call.function.name}
                  </span>
                  <span class="text-[#8b949e] font-mono text-xs overflow-hidden text-ellipsis whitespace-nowrap max-w-[300px]">
                    {formatToolArgs(exec.call.function.arguments)}
                  </span>
                </div>
                <Show when={exec.result && exec.status !== "pending"}>
                  <details class="mt-1.5 text-xs">
                    <summary class="cursor-pointer text-[#8b949e] select-none hover:text-[#c9d1d9]">
                      Result
                    </summary>
                    <pre class="mt-1.5 mb-0 p-2 bg-[rgba(0,0,0,0.3)] rounded text-[11px] overflow-x-auto max-h-[200px] whitespace-pre-wrap break-words">
                      {formatToolResultText(exec.result?.content ?? "")}
                    </pre>
                  </details>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Message content */}
      <div
        class="text-[15px] leading-[1.7] text-[#e6edf3] break-words"
        innerHTML={content() ? renderMarkdown(content()) : ""}
      />
      {isStreaming() && (
        <span class="inline-block w-0.5 h-[1em] bg-[#58a6ff] ml-0.5 align-text-bottom animate-[blink_1s_step-end_infinite]" />
      )}
    </article>
  );
};
