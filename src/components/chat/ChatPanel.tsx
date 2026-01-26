/* eslint-disable solid/no-innerhtml */
import type { Component } from "solid-js";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  type ChatContext,
  type Message,
  streamMessage,
  sendMessageWithRetry,
  CHAT_MAX_RETRIES,
} from "@/services/chat";
import { catalog, type Publisher } from "@/services/catalog";
import { chatStore } from "@/stores/chat.store";
import { editorStore } from "@/stores/editor.store";
import { authStore, checkAuth } from "@/stores/auth.store";
import { settingsStore } from "@/stores/settings.store";
import { StreamingMessage } from "./StreamingMessage";
import { ModelSelector } from "./ModelSelector";
import { PublisherSuggestions } from "./PublisherSuggestions";
import { SignIn } from "@/components/auth/SignIn";
import { FileTree } from "@/components/sidebar/FileTree";
import { fileTreeState, setNodes } from "@/stores/fileTree";
import { openFolder, openFileInTab, loadDirectoryChildren } from "@/lib/files/service";
import { renderMarkdown } from "@/lib/render-markdown";
import { escapeHtml } from "@/lib/escape-html";
import "./ChatPanel.css";
import "highlight.js/styles/github-dark.css";

// Keywords that trigger publisher suggestions
const SUGGESTION_KEYWORDS = [
  "scrape", "crawl", "fetch", "search", "query", "database",
  "api", "web", "data", "analyze", "extract", "research",
];

interface StreamingSession {
  id: string;
  userMessageId: string;
  prompt: string;
  model: string;
  context?: ChatContext;
  stream: AsyncGenerator<string>;
}

interface ChatPanelProps {
  onSignInClick?: () => void;
}

interface ChatPanelComponent extends Component<ChatPanelProps> {
  focusInput?: () => void;
}

export const ChatPanel: Component<ChatPanelProps> = (_props) => {
  const [input, setInput] = createSignal("");
  const [streamingSession, setStreamingSession] = createSignal<StreamingSession | null>(null);
  const [suggestions, setSuggestions] = createSignal<Publisher[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = createSignal(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = createSignal(false);
  let inputRef: HTMLTextAreaElement | undefined;
  let messagesRef: HTMLDivElement | undefined;
  let suggestionDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  const scrollToBottom = () => {
    if (messagesRef) {
      messagesRef.scrollTop = messagesRef.scrollHeight;
    }
  };

  onMount(async () => {
    try {
      await chatStore.loadHistory();
    } catch (error) {
      chatStore.setError((error as Error).message);
    }
  });

  // Auto-scroll to bottom when messages change or streaming starts
  createEffect(() => {
    // Track both messages array and streaming session
    const _messages = chatStore.messages;
    const _streaming = streamingSession();
    // Scroll after render
    requestAnimationFrame(scrollToBottom);
  });

  onCleanup(() => {
    if (suggestionDebounceTimer) {
      clearTimeout(suggestionDebounceTimer);
    }
  });

  // Check if input contains suggestion-triggering keywords
  const shouldShowSuggestions = (text: string): boolean => {
    const lowerText = text.toLowerCase();
    return SUGGESTION_KEYWORDS.some((keyword) => lowerText.includes(keyword));
  };

  // Debounced fetch for publisher suggestions
  const fetchSuggestions = async (query: string) => {
    if (!authStore.isAuthenticated || suggestionsDismissed()) return;

    if (!shouldShowSuggestions(query)) {
      setSuggestions([]);
      return;
    }

    setSuggestionsLoading(true);
    try {
      const results = await catalog.suggest(query);
      setSuggestions(results.slice(0, 3)); // Show max 3 suggestions
    } catch {
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  };

  // Watch input changes for suggestions
  createEffect(() => {
    const text = input();
    if (suggestionDebounceTimer) {
      clearTimeout(suggestionDebounceTimer);
    }

    if (text.length < 10) {
      setSuggestions([]);
      return;
    }

    suggestionDebounceTimer = setTimeout(() => {
      fetchSuggestions(text);
    }, 500); // 500ms debounce
  });

  const handlePublisherSelect = (publisher: Publisher) => {
    // Add publisher mention to input
    const currentInput = input();
    const mention = `@${publisher.slug} `;
    setInput(currentInput + (currentInput.endsWith(" ") ? "" : " ") + mention);
    setSuggestions([]);
    inputRef?.focus();
  };

  const dismissSuggestions = () => {
    setSuggestions([]);
    setSuggestionsDismissed(true);
  };

  // File tree handlers
  const [isLoadingFolder, setIsLoadingFolder] = createSignal(false);

  const handleOpenFolder = async () => {
    setIsLoadingFolder(true);
    try {
      await openFolder();
    } catch (error) {
      console.error("Failed to open folder:", error);
    } finally {
      setIsLoadingFolder(false);
    }
  };

  const handleFileSelect = async (path: string) => {
    try {
      await openFileInTab(path);
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  };

  const handleDirectoryToggle = async (path: string, expanded: boolean) => {
    if (expanded) {
      try {
        const children = await loadDirectoryChildren(path);
        const updatedNodes = updateNodeChildren(fileTreeState.nodes, path, children);
        setNodes(updatedNodes);
      } catch (error) {
        console.error("Failed to load directory:", error);
      }
    }
  };

  // Reset dismissed state when input is cleared
  createEffect(() => {
    if (input().length === 0) {
      setSuggestionsDismissed(false);
    }
  });

  /**
   * Focus the chat input. Called by keyboard shortcut.
   */
  const focusInput = () => {
    inputRef?.focus();
  };

  // Expose focusInput for parent components
  (ChatPanel as ChatPanelComponent).focusInput = focusInput;

  const contextPreview = createMemo(() => {
    if (!editorStore.selectedText) return null;
    return {
      text: editorStore.selectedText,
      file: editorStore.selectedFile,
      range: editorStore.selectedRange,
    };
  });

  const buildContext = (): ChatContext | undefined => {
    if (!editorStore.selectedText) return undefined;
    return {
      content: editorStore.selectedText,
      file: editorStore.selectedFile,
      range: editorStore.selectedRange ?? undefined,
    };
  };

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

    const context = buildContext();
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

      const updated = {
        ...message,
        content,
        status: "complete" as const,
        error: null,
        timestamp: Date.now(),
      };

      chatStore.updateMessage(message.id, updated);
      await chatStore.persistMessage(updated);
    } catch (error) {
      const messageError = (error as Error).message;
      chatStore.updateMessage(message.id, {
        status: "error",
        error: messageError,
      });
      if (isManual) {
        chatStore.setError(messageError);
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
      {/* File Explorer Sidebar */}
      <aside class="chat-sidebar">
        <div class="chat-sidebar-header">
          <span>Explorer</span>
          <button
            type="button"
            onClick={handleOpenFolder}
            disabled={isLoadingFolder()}
            title="Open Folder"
          >
            {isLoadingFolder() ? "..." : "+"}
          </button>
        </div>
        <div class="chat-file-tree">
          <FileTree
            onFileSelect={handleFileSelect}
            onDirectoryToggle={handleDirectoryToggle}
          />
        </div>
      </aside>

      {/* Main Chat Area */}
      <div class="chat-main">
        <Show
          when={authStore.isAuthenticated}
          fallback={
            <div class="chat-signin-prompt">
              <div class="signin-prompt-header">
                <h2>Sign in to chat</h2>
                <p>Connect with Seren to access AI-powered conversations and code assistance.</p>
              </div>
              <SignIn onSuccess={() => checkAuth()} />
            </div>
          }
        >
        <header class="chat-header">
          <div class="chat-header-left">
            <ModelSelector />
          </div>
          <div class="chat-actions">
            <button type="button" class="clear-btn" onClick={clearHistory}>
              Clear
            </button>
          </div>
        </header>

      <div class="chat-messages" ref={messagesRef}>
        <Show
          when={chatStore.messages.length > 0}
          fallback={
            <div class="chat-empty">
              <h3>Start a conversation</h3>
              <p>Ask questions about code, get explanations, or request help with programming tasks.</p>
            </div>
          }
        >
          <For each={chatStore.messages}>
            {(message) => (
              <article class={`chat-message ${message.role}`}>
                <div
                  class="message-content"
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
                      <button type="button" onClick={() => handleManualRetry(message)}>Retry</button>
                    </Show>
                  </div>
                </Show>
              </article>
            )}
          </For>
        </Show>

        <Show when={streamingSession()}>
          {(sessionAccessor) => {
            // Capture session immediately to avoid stale accessor in callbacks
            const session = sessionAccessor();
            return (
              <StreamingMessage
                stream={session.stream}
                onComplete={(content) => handleStreamingComplete(session, content)}
                onError={(error) => handleStreamingError(session, error)}
                onContentUpdate={scrollToBottom}
              />
            );
          }}
        </Show>
      </div>

      <Show when={contextPreview()}>
        {(ctx) => (
          <div class="chat-context">
            <div class="context-header">
              <span>
                Context from {ctx().file ?? "selection"}
                {ctx().range &&
                  ` (${ctx().range?.startLine}-${ctx().range?.endLine})`}
              </span>
              <button type="button" class="icon" onClick={() => editorStore.clearSelection()}>
                ×
              </button>
            </div>
            <pre>{ctx().text}</pre>
          </div>
        )}
      </Show>

      <div class="chat-input-container">
        <form
          class="chat-input"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <PublisherSuggestions
            suggestions={suggestions()}
            isLoading={suggestionsLoading()}
            onSelect={handlePublisherSelect}
            onDismiss={dismissSuggestions}
          />
          <textarea
            ref={inputRef}
            value={input()}
            placeholder="Ask Seren anything…"
            onInput={(event) => setInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const enterToSend = settingsStore.get("chatEnterToSend");
                if (enterToSend) {
                  // Enter sends, Shift+Enter for newline
                  if (!event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                } else {
                  // Ctrl/Cmd+Enter sends
                  if (event.metaKey || event.ctrlKey) {
                    event.preventDefault();
                    sendMessage();
                  }
                }
              }
            }}
            disabled={chatStore.isLoading}
          />
          <div class="input-footer">
            <span class="input-hint">
              {settingsStore.get("chatEnterToSend")
                ? "Enter to send"
                : "Ctrl+Enter to send"}
            </span>
            <button type="submit" disabled={chatStore.isLoading}>
              Send
            </button>
          </div>
        </form>
      </div>
      </Show>
      </div>
    </section>
  );
};

/**
 * Recursively update children for a node in the tree.
 */
function updateNodeChildren(
  nodes: typeof fileTreeState.nodes,
  path: string,
  children: typeof fileTreeState.nodes
): typeof fileTreeState.nodes {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, children };
    }
    if (node.children) {
      return {
        ...node,
        children: updateNodeChildren(node.children, path, children),
      };
    }
    return node;
  });
}
