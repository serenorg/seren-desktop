// ABOUTME: Chat content panel without file tree for resizable layout.
// ABOUTME: Shows chat messages, input, and model selector.

/* eslint-disable solid/no-innerhtml */
import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { SignIn } from "@/components/auth/SignIn";
import { escapeHtml } from "@/lib/escape-html";
import { renderMarkdown } from "@/lib/render-markdown";
import { catalog, type Publisher } from "@/services/catalog";
import {
  areToolsAvailable,
  CHAT_MAX_RETRIES,
  type ChatContext,
  type Message,
  sendMessageWithRetry,
  streamMessage,
  streamMessageWithTools,
  type ToolStreamEvent,
} from "@/services/chat";
import { authStore, checkAuth } from "@/stores/auth.store";
import { chatStore } from "@/stores/chat.store";
import { editorStore } from "@/stores/editor.store";
import { settingsStore } from "@/stores/settings.store";
import { ChatTabBar } from "./ChatTabBar";
import { ModelSelector } from "./ModelSelector";
import { PublisherSuggestions } from "./PublisherSuggestions";
import { StreamingMessage } from "./StreamingMessage";
import { ToolStreamingMessage } from "./ToolStreamingMessage";
import "highlight.js/styles/github-dark.css";

// Keywords that trigger publisher suggestions
const SUGGESTION_KEYWORDS = [
  "scrape",
  "crawl",
  "fetch",
  "search",
  "query",
  "database",
  "api",
  "web",
  "data",
  "analyze",
  "extract",
  "research",
];

interface StreamingSession {
  id: string;
  userMessageId: string;
  prompt: string;
  model: string;
  context?: ChatContext;
  stream: AsyncGenerator<string>;
  toolsEnabled: false;
}

interface ToolStreamingSession {
  id: string;
  userMessageId: string;
  prompt: string;
  model: string;
  context?: ChatContext;
  stream: AsyncGenerator<ToolStreamEvent>;
  toolsEnabled: true;
}

type ActiveStreamingSession = StreamingSession | ToolStreamingSession;

interface ChatContentProps {
  onSignInClick?: () => void;
}

export const ChatContent: Component<ChatContentProps> = (_props) => {
  const [input, setInput] = createSignal("");
  const [streamingSession, setStreamingSession] =
    createSignal<ActiveStreamingSession | null>(null);
  const [suggestions, setSuggestions] = createSignal<Publisher[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = createSignal(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = createSignal(false);
  // Input history navigation (terminal-style up/down arrow)
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [savedInput, setSavedInput] = createSignal("");
  // Message queue for sending messages while streaming
  const [messageQueue, setMessageQueue] = createSignal<string[]>([]);
  let inputRef: HTMLTextAreaElement | undefined;
  let messagesRef: HTMLDivElement | undefined;
  let suggestionDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Copy button click handler (event delegation)
  const handleCopyClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const copyBtn = target.closest(".code-copy-btn") as HTMLButtonElement;

    if (copyBtn) {
      const code = copyBtn.dataset.code;
      if (code) {
        // Decode HTML entities
        const textarea = document.createElement("textarea");
        textarea.innerHTML = code;
        const decodedCode = textarea.value;

        // Copy to clipboard
        navigator.clipboard
          .writeText(decodedCode)
          .then(() => {
            // Visual feedback
            const originalText = copyBtn.innerHTML;
            copyBtn.classList.add("copied");
            copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path>
            </svg>Copied!`;

            setTimeout(() => {
              copyBtn.classList.remove("copied");
              copyBtn.innerHTML = originalText;
            }, 2000);
          })
          .catch((err) => {
            console.error("Failed to copy code:", err);
          });
      }
    }
  };

  const scrollToBottom = () => {
    if (messagesRef) {
      messagesRef.scrollTop = messagesRef.scrollHeight;
    }
  };

  // Keyboard shortcuts for tab management
  const handleKeyDown = (event: KeyboardEvent) => {
    const isMod = event.metaKey || event.ctrlKey;

    // Ctrl/Cmd+T: New tab
    if (isMod && event.key === "t") {
      event.preventDefault();
      chatStore.createConversation();
      return;
    }

    // Ctrl/Cmd+W: Close current tab
    if (isMod && event.key === "w") {
      event.preventDefault();
      const activeId = chatStore.activeConversationId;
      if (activeId) {
        chatStore.archiveConversation(activeId);
      }
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: Switch tabs
    if (event.ctrlKey && event.key === "Tab") {
      event.preventDefault();
      const conversations = chatStore.conversations.filter(
        (c) => !c.isArchived,
      );
      if (conversations.length < 2) return;

      const currentIndex = conversations.findIndex(
        (c) => c.id === chatStore.activeConversationId,
      );
      if (currentIndex === -1) return;

      const nextIndex = event.shiftKey
        ? (currentIndex - 1 + conversations.length) % conversations.length
        : (currentIndex + 1) % conversations.length;

      chatStore.setActiveConversation(conversations[nextIndex].id);
    }
  };

  onMount(async () => {
    console.log("[ChatContent] Mounting, chatStore.isLoading:", chatStore.isLoading);

    // Reset orphaned loading state from HMR interruption
    if (chatStore.isLoading && !streamingSession()) {
      console.log("[ChatContent] Resetting orphaned loading state from HMR");
      chatStore.setLoading(false);
    }

    document.addEventListener("keydown", handleKeyDown);

    // Register copy button handler (event delegation)
    messagesRef?.addEventListener("click", handleCopyClick);

    try {
      await chatStore.loadHistory();
    } catch (error) {
      chatStore.setError((error as Error).message);
    }
  });

  // Debug: log when loading state changes
  createEffect(() => {
    console.log("[ChatContent] chatStore.isLoading changed to:", chatStore.isLoading);
  });

  // Auto-scroll to bottom when messages change or streaming starts
  createEffect(() => {
    void chatStore.messages;
    void streamingSession();
    requestAnimationFrame(scrollToBottom);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
    messagesRef?.removeEventListener("click", handleCopyClick);

    // Reset loading state if still active when unmounting (e.g., HMR)
    if (chatStore.isLoading) {
      console.log("[ChatContent] Cleaning up loading state on unmount");
      chatStore.setLoading(false);
    }

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
      setSuggestions(results.slice(0, 3));
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
    }, 500);
  });

  const handlePublisherSelect = (publisher: Publisher) => {
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

  // Reset dismissed state when input is cleared
  createEffect(() => {
    if (input().length === 0) {
      setSuggestionsDismissed(false);
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

  // User message history for up/down arrow navigation
  const userMessageHistory = createMemo(() =>
    chatStore.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .reverse(),
  );

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

    // If currently streaming, queue the message instead
    if (chatStore.isLoading) {
      setMessageQueue((queue) => [...queue, trimmed]);
      setInput("");
      setHistoryIndex(-1);
      setSavedInput("");
      console.log("[ChatContent] Message queued:", trimmed);
      return;
    }

    // Send message immediately
    await sendMessageImmediate(trimmed);
  };

  const sendMessageImmediate = async (messageContent: string) => {
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: messageContent,
      timestamp: Date.now(),
      model: chatStore.selectedModel,
      status: "complete",
    };

    chatStore.addMessage(userMessage);
    await chatStore.persistMessage(userMessage);

    const context = buildContext();
    const assistantId = crypto.randomUUID();

    const useTools = areToolsAvailable();
    const session: ActiveStreamingSession = useTools
      ? {
          id: assistantId,
          userMessageId: userMessage.id,
          prompt: messageContent,
          model: chatStore.selectedModel,
          context,
          stream: streamMessageWithTools(
            messageContent,
            chatStore.selectedModel,
            context,
            true,
            chatStore.messages,
          ),
          toolsEnabled: true,
        }
      : {
          id: assistantId,
          userMessageId: userMessage.id,
          prompt: messageContent,
          model: chatStore.selectedModel,
          context,
          stream: streamMessage(messageContent, chatStore.selectedModel, context),
          toolsEnabled: false,
        };

    chatStore.setLoading(true);
    setStreamingSession(session);
    chatStore.setError(null);
    setInput("");
    setHistoryIndex(-1);
    setSavedInput("");
  };

  const handleStreamingComplete = async (
    session: ActiveStreamingSession,
    content: string,
  ) => {
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

    // Process message queue if there are queued messages
    const queue = messageQueue();
    if (queue.length > 0) {
      const [nextMessage, ...remainingQueue] = queue;
      setMessageQueue(remainingQueue);
      console.log("[ChatContent] Processing queued message:", nextMessage);
      // Small delay to ensure UI updates
      setTimeout(() => {
        sendMessageImmediate(nextMessage);
      }, 100);
    }
  };

  const handleStreamingError = async (
    session: ActiveStreamingSession,
    error: Error,
  ) => {
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
        },
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
    <section class="flex flex-col h-full bg-[#0d1117] text-[#e6edf3] border-l border-[#21262d]">
      <Show
        when={authStore.isAuthenticated}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center gap-6 p-6">
            <div class="text-center max-w-[280px]">
              <h2 class="m-0 mb-2 text-lg font-semibold text-[#e6edf3]">
                Sign in to chat
              </h2>
              <p class="m-0 text-sm text-[#8b949e] leading-normal">
                Connect with Seren to access AI-powered conversations.
              </p>
            </div>
            <SignIn onSuccess={() => checkAuth()} />
          </div>
        }
      >
        <ChatTabBar />
        <header class="shrink-0 flex justify-between items-center px-3 py-2 border-b border-[#21262d] bg-[#161b22]">
          <span class="text-xs font-medium text-[#8b949e]">Chat</span>
          <button
            type="button"
            class="bg-transparent border border-[#30363d] text-[#8b949e] px-2 py-1 rounded text-xs cursor-pointer transition-all hover:bg-[#21262d] hover:text-[#e6edf3]"
            onClick={clearHistory}
          >
            Clear
          </button>
        </header>

        <div
          class="flex-1 min-h-0 overflow-y-auto pb-4 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[#30363d] [&::-webkit-scrollbar-thumb]:rounded"
          ref={messagesRef}
        >
          <Show
            when={chatStore.messages.length > 0}
            fallback={
              <div class="flex-1 flex flex-col items-center justify-center p-6 text-[#8b949e]">
                <h3 class="m-0 mb-2 text-base font-medium text-[#e6edf3]">
                  Start a conversation
                </h3>
                <p class="m-0 text-sm text-center max-w-[240px]">
                  Ask questions about code or request help with tasks.
                </p>
              </div>
            }
          >
            <For each={chatStore.messages}>
              {(message) => (
                <article
                  class={`px-4 py-3 border-b border-[#21262d] last:border-b-0 ${message.role === "user" ? "bg-[#161b22]" : "bg-transparent"}`}
                >
                  <div
                    class="text-sm leading-relaxed text-[#e6edf3] break-words [&_p]:m-0 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_code]:bg-[#21262d] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-mono [&_code]:text-[13px] [&_pre]:bg-[#161b22] [&_pre]:border [&_pre]:border-[#30363d] [&_pre]:rounded-lg [&_pre]:p-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-[#58a6ff]"
                    innerHTML={
                      message.role === "assistant"
                        ? renderMarkdown(message.content)
                        : escapeHtml(message.content)
                    }
                  />
                  <Show when={message.status === "error"}>
                    <div class="mt-2 px-2 py-1.5 bg-[rgba(248,81,73,0.1)] border border-[rgba(248,81,73,0.4)] rounded flex items-center gap-2 text-xs text-[#f85149]">
                      <span>{message.error ?? "Message failed"}</span>
                      <Show when={chatStore.retryingMessageId === message.id}>
                        <span>
                          Retrying (
                          {Math.min(message.attemptCount ?? 1, CHAT_MAX_RETRIES)}
                          /{CHAT_MAX_RETRIES})…
                        </span>
                      </Show>
                      <Show when={message.request}>
                        <button
                          type="button"
                          class="bg-transparent border border-[rgba(248,81,73,0.4)] text-[#f85149] px-2 py-0.5 rounded text-xs cursor-pointer hover:bg-[rgba(248,81,73,0.15)]"
                          onClick={() => handleManualRetry(message)}
                        >
                          Retry
                        </button>
                      </Show>
                    </div>
                  </Show>
                </article>
              )}
            </For>
          </Show>

          <Show when={streamingSession()}>
            {(sessionAccessor) => {
              const session = sessionAccessor();
              return (
                <Show
                  when={session.toolsEnabled}
                  fallback={
                    <StreamingMessage
                      stream={(session as StreamingSession).stream}
                      onComplete={(content) =>
                        handleStreamingComplete(session, content)
                      }
                      onError={(error) => handleStreamingError(session, error)}
                      onContentUpdate={scrollToBottom}
                    />
                  }
                >
                  <ToolStreamingMessage
                    stream={(session as ToolStreamingSession).stream}
                    onComplete={(content) =>
                      handleStreamingComplete(session, content)
                    }
                    onError={(error) => handleStreamingError(session, error)}
                    onContentUpdate={scrollToBottom}
                  />
                </Show>
              );
            }}
          </Show>
        </div>

        <Show when={contextPreview()}>
          {(ctx) => (
            <div class="mx-3 my-2 bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
              <div class="flex justify-between items-center px-2 py-1.5 bg-[#21262d] text-xs text-[#8b949e]">
                <span>
                  Context from {ctx().file ?? "selection"}
                  {ctx().range &&
                    ` (${ctx().range?.startLine}-${ctx().range?.endLine})`}
                </span>
                <button
                  type="button"
                  class="bg-transparent border-none text-[#8b949e] cursor-pointer px-1 py-0.5 text-sm leading-none hover:text-[#e6edf3]"
                  onClick={() => editorStore.clearSelection()}
                >
                  ×
                </button>
              </div>
              <pre class="m-0 p-2 max-h-[80px] overflow-y-auto text-xs leading-normal bg-transparent">
                {ctx().text}
              </pre>
            </div>
          )}
        </Show>

        <div class="shrink-0 p-3 border-t border-[#21262d] bg-[#161b22]">
          <form
            class="flex flex-col gap-2"
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
            <Show when={messageQueue().length > 0}>
              <div class="flex items-center gap-2 px-3 py-2 bg-[#21262d] border border-[#30363d] rounded-lg text-xs text-[#8b949e]">
                <span>
                  {messageQueue().length} message{messageQueue().length > 1 ? "s" : ""} queued
                </span>
                <button
                  type="button"
                  class="ml-auto bg-transparent border border-[#30363d] text-[#8b949e] px-2 py-0.5 rounded text-xs cursor-pointer hover:bg-[#30363d] hover:text-[#e6edf3]"
                  onClick={() => setMessageQueue([])}
                >
                  Clear Queue
                </button>
              </div>
            </Show>
            <textarea
              ref={(el) => {
                inputRef = el;
                console.log("[ChatContent] Textarea ref set, disabled:", el.disabled, "isLoading:", chatStore.isLoading);
              }}
              value={input()}
              placeholder={chatStore.isLoading ? "Type to queue message..." : "Ask Seren anything…"}
              class="w-full min-h-[60px] max-h-[150px] resize-none bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] p-2 font-inherit text-sm leading-normal transition-colors focus:outline-none focus:border-[#58a6ff] placeholder:text-[#484f58]"
              onInput={(event) => {
                setInput(event.currentTarget.value);
                if (historyIndex() !== -1) {
                  setHistoryIndex(-1);
                  setSavedInput("");
                }
              }}
              onKeyDown={(event) => {
                const history = userMessageHistory();

                // Up arrow: navigate to older message
                if (event.key === "ArrowUp" && history.length > 0) {
                  const textarea = event.currentTarget;
                  if (textarea.selectionStart === 0 || input() === "") {
                    event.preventDefault();

                    if (historyIndex() === -1) {
                      setSavedInput(input());
                    }

                    const newIndex = Math.min(
                      historyIndex() + 1,
                      history.length - 1,
                    );
                    setHistoryIndex(newIndex);
                    setInput(history[newIndex]);
                  }
                }

                // Down arrow: navigate to newer message
                if (event.key === "ArrowDown" && historyIndex() >= 0) {
                  const textarea = event.currentTarget;
                  if (textarea.selectionStart === textarea.value.length) {
                    event.preventDefault();

                    const newIndex = historyIndex() - 1;
                    setHistoryIndex(newIndex);

                    if (newIndex < 0) {
                      setInput(savedInput());
                      setSavedInput("");
                    } else {
                      setInput(history[newIndex]);
                    }
                  }
                }

                // Enter key handling
                if (event.key === "Enter") {
                  const enterToSend = settingsStore.get("chatEnterToSend");
                  if (enterToSend) {
                    if (!event.shiftKey) {
                      event.preventDefault();
                      sendMessage();
                    }
                  } else {
                    if (event.metaKey || event.ctrlKey) {
                      event.preventDefault();
                      sendMessage();
                    }
                  }
                }
              }}
            />
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-2">
                <ModelSelector />
                <span class="text-[10px] text-[#484f58]">
                  {settingsStore.get("chatEnterToSend")
                    ? chatStore.isLoading ? "Enter to queue" : "Enter to send"
                    : chatStore.isLoading ? "Ctrl+Enter to queue" : "Ctrl+Enter"}
                </span>
              </div>
              <button
                type="submit"
                class="bg-[#238636] text-white border-none px-3 py-1 rounded text-xs font-medium cursor-pointer transition-colors hover:bg-[#2ea043] disabled:bg-[#21262d] disabled:text-[#484f58]"
                disabled={!input().trim()}
              >
                {chatStore.isLoading ? "Queue" : "Send"}
              </button>
            </div>
          </form>
        </div>
      </Show>
    </section>
  );
};
