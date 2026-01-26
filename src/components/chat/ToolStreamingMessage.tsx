/* eslint-disable solid/no-innerhtml */
// ABOUTME: Streaming message component with tool execution display.
// ABOUTME: Shows tool calls being executed and their results during chat.

import type { Component } from "solid-js";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ToolCall, ToolResult } from "@/lib/providers/types";
import { renderMarkdown } from "@/lib/render-markdown";
import type { ToolStreamEvent } from "@/services/chat";
import "./ToolStreamingMessage.css";

interface ToolStreamingMessageProps {
  stream: AsyncGenerator<ToolStreamEvent>;
  onComplete: (fullContent: string) => void;
  onError?: (error: Error) => void;
  onContentUpdate?: () => void;
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
  const [toolExecutions, setToolExecutions] = createSignal<ToolExecution[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(true);
  let isCancelled = false;

  const consume = async () => {
    let fullContent = "";
    let hadError = false;

    try {
      for await (const event of props.stream) {
        if (isCancelled) break;

        switch (event.type) {
          case "content":
            fullContent += event.content;
            setContent(fullContent);
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
            break;
        }
      }
    } catch (error) {
      hadError = true;
      props.onError?.(error as Error);
    } finally {
      setIsStreaming(false);
      if (!isCancelled && !hadError) {
        props.onComplete(fullContent);
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

  return (
    <article class="chat-message assistant streaming">
      {/* Tool executions */}
      <Show when={toolExecutions().length > 0}>
        <div class="tool-executions">
          <For each={toolExecutions()}>
            {(exec) => (
              <div class={`tool-execution ${exec.status}`}>
                <div class="tool-header">
                  <span class="tool-icon">
                    {exec.status === "pending"
                      ? "⏳"
                      : exec.status === "error"
                        ? "❌"
                        : "✓"}
                  </span>
                  <span class="tool-name">{exec.call.function.name}</span>
                  <span class="tool-args">
                    {formatToolArgs(exec.call.function.arguments)}
                  </span>
                </div>
                <Show when={exec.result && exec.status !== "pending"}>
                  <details class="tool-result">
                    <summary>Result</summary>
                    <pre>{exec.result?.content}</pre>
                  </details>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Message content */}
      <div
        class="message-content"
        innerHTML={content() ? renderMarkdown(content()) : ""}
      />
      {isStreaming() && <span class="streaming-cursor" />}
    </article>
  );
};
