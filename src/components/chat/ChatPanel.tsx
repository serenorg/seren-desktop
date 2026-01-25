/* eslint-disable solid/no-innerhtml */
import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import {
  type ChatContext,
  type Message,
  streamMessage,
  sendMessageWithRetry,
  CHAT_MAX_RETRIES,
} from "@/services/chat";
import { chatStore } from "@/stores/chat.store";
import { editorStore } from "@/stores/editor.store";
import { StreamingMessage } from "./StreamingMessage";
import { ModelSelector } from "./ModelSelector";
import { formatRelativeTime } from "@/lib/format-time";
import { renderMarkdown } from "@/lib/render-markdown";
import { escapeHtml } from "@/lib/escape-html";
import "./ChatPanel.css";
import "highlight.js/styles/github.css";

interface StreamingSession {
  id: string;
  userMessageId: string;
  prompt: string;
  model: string;
  context?: ChatContext;
  stream: AsyncGenerator<string>;
}

export const ChatPanel: Component = () => {
  const [input, setInput] = createSignal("");
  const [streamingSession, setStreamingSession] = createSignal<StreamingSession | null>(null);

  onMount(async () => {
    try {
      await chatStore.loadHistory();
    } catch (error) {
      chatStore.setError((error as Error).message);
    }
  });

  const contextPreview = createMemo(() => {
    if (!editorStore.selectedText) return null;
    return {
      text: editorStore.selectedText,
      file: editorStore.selectedFile,
      range: editorStore.selectedRange,
    };
  });

  const sendMessage = async () => {
    const trimmed = input().trim();
    if (!trimmed) return;

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
      model: chatStore.selectedModel,
      status: "complete",
    };

    chatStore.addMessage(userMessage);
    await chatStore.persistMessage(userMessage);

    const context = getContextForApi();
    const assistantId = crypto.randomUUID();

    const session: StreamingSession = {
      id: assistantId,
      userMessageId: userMessage.id,
      prompt: trimmed,
      model: chatStore.selectedModel,
      context,
      stream: streamMessage(trimmed, chatStore.selectedModel, context),
    };

    chatStore.setLoading(true);
    setStreamingSession(session);
    chatStore.setError(null);
    setInput("");
  };

  const getContextForApi = (): ChatContext | undefined => {
    if (!editorStore.selectedText) return undefined;
    return {
      content: editorStore.selectedText,
      file: editorStore.selectedFile,
      range: editorStore.selectedRange ?? undefined,
    };
  };

  const handleStreamingComplete = async (session: StreamingSession, content: string) => {
    const assistantMessage: Message = {
      id: session.id,
      role: "assistant",
      content,
      timestamp: Date.now(),
      model: session.model,
      status: "complete",
      request: { prompt: session.prompt, context: session.context },
    };

    chatStore.addMessage(assistantMessage);
    await chatStore.persistMessage(assistantMessage);
    setStreamingSession(null);
    chatStore.setLoading(false);
  };

  const handleStreamingError = async (session: StreamingSession, error: Error) => {
    setStreamingSession(null);
    chatStore.setLoading(false);
    chatStore.setError(error.message);

    const failedMessage: Message = {
      id: session.id,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      model: session.model,
      status: "error",
      error: error.message,
      request: { prompt: session.prompt, context: session.context },
    };

    chatStore.addMessage(failedMessage);
    await attemptRetry(failedMessage, false);
  };

  const attemptRetry = async (message: Message, isManual: boolean) => {
    if (!message.request) return;

    chatStore.setRetrying(message.id);
    chatStore.updateMessage(message.id, {
      status: "pending",
      attemptCount: message.attemptCount ?? 1,
    });

    try {
      const content = await sendMessageWithRetry(
        message.request.prompt,
        message.model ?? chatStore.selectedModel,
        message.request.context,
        (attempt) => {
          chatStore.updateMessage(message.id, {
            status: "pending",
            attemptCount: attempt + 1,
          });
        }
      );

      chatStore.updateMessage(message.id, {
        content,
        status: "complete",
        error: null,
        timestamp: Date.now(),
      });

      await chatStore.persistMessage({
        ...message,
        content,
        status: "complete",
        error: null,
        timestamp: Date.now(),
      });
    } catch (error) {
      chatStore.updateMessage(message.id, {
        status: "error",
        error: (error as Error).message,
      });
      if (isManual) {
        chatStore.setError((error as Error).message);
      }
    } finally {
      chatStore.setRetrying(null);
    }
  };

  const handleManualRetry = async (message: Message) => {
    await attemptRetry(message, true);
  };

  const clearHistory = async () => {
    const confirmClear = window.confirm("Clear all chat history?");
    if (!confirmClear) return;
    await chatStore.clearHistory();
  };

  return (
    <section class="chat-panel">
      <header class="chat-header">
        <div>
          <h1>Seren Chat</h1>
          <p class="chat-subtitle">Ask questions with streaming responses.</p>
        </div>
        <div class="chat-actions">
          <ModelSelector />
          <button class="secondary" onClick={clearHistory}>
            Clear history
          </button>
        </div>
      </header>

      <div class="chat-messages">
        <For each={chatStore.messages}>
          {(message) => (
            <article class={`chat-message ${message.role}`}>
              <div class="message-header">
                <span class="role">{message.role === "user" ? "You" : "Seren"}</span>
                <span class="timestamp">{formatRelativeTime(message.timestamp)}</span>
              </div>
              <div
                class="message-body"
                innerHTML={
                  message.role === "assistant"
                    ? renderMarkdown(message.content)
                    : escapeHtml(message.content)
                }
              />
              <Show when={message.status === "error"}>
                <div class="message-error">
                  <span>{message.error ?? "Message failed"}</span>
                  <Show when={chatStore.retryingMessageId === message.id}>
                    <span>
                      Retrying ({Math.min(message.attemptCount ?? 1, CHAT_MAX_RETRIES)}/
                      {CHAT_MAX_RETRIES})…
                    </span>
                  </Show>
                  <Show when={message.request}>
                    <button onClick={() => handleManualRetry(message)}>Retry</button>
                  </Show>
                </div>
              </Show>
            </article>
          )}
        </For>

        <Show when={streamingSession()}>
          {(sessionAccessor) => (
            <StreamingMessage
              stream={sessionAccessor().stream}
              onComplete={(content) => handleStreamingComplete(sessionAccessor(), content)}
              onError={(error) => handleStreamingError(sessionAccessor(), error)}
            />
          )}
        </Show>
      </div>

      <Show when={contextPreview()}>
        {(ctx) => (
          <div class="chat-context">
            <div class="context-header">
              <span>
                Context from {ctx().file ?? "selection"}
                {ctx().range &&
                  ` (${ctx().range.startLine}-${ctx().range.endLine})`}
              </span>
              <button class="icon" onClick={() => editorStore.clearSelection()}>
                ×
              </button>
            </div>
            <pre>{ctx().text}</pre>
          </div>
        )}
      </Show>

      <form
        class="chat-input"
        onSubmit={(event) => {
          event.preventDefault();
          sendMessage();
        }}
      >
        <textarea
          value={input()}
          placeholder="Ask Seren anything…"
          onInput={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              sendMessage();
            }
          }}
          disabled={chatStore.isLoading}
        />
        <div class="input-footer">
          <span class="helper-text">
            {chatStore.isLoading ? "Streaming…" : "Ctrl+Enter to send"}
          </span>
          <button type="submit" disabled={chatStore.isLoading}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
};
