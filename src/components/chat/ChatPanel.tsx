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
import { FileTree } from "@/components/sidebar/FileTree";
import { escapeHtml } from "@/lib/escape-html";
import {
  loadDirectoryChildren,
  openFileInTab,
  openFolder,
} from "@/lib/files/service";
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
import { acpStore } from "@/stores/acp.store";
import { authStore, checkAuth } from "@/stores/auth.store";
import { chatStore } from "@/stores/chat.store";
import { editorStore } from "@/stores/editor.store";
import { fileTreeState, setNodes } from "@/stores/fileTree";
import { settingsStore } from "@/stores/settings.store";
import { AgentChat } from "./AgentChat";
import { AgentModeToggle } from "./AgentModeToggle";
import {
  type BalanceInfo,
  BalanceWarning,
  isBalanceError,
  parseBalanceError,
} from "./BalanceWarning";
import { ChatTabBar } from "./ChatTabBar";
import { ModelSelector } from "./ModelSelector";
import { PublisherSuggestions } from "./PublisherSuggestions";
import { StreamingMessage } from "./StreamingMessage";
import { ThinkingBlock } from "./ThinkingBlock";
import { ThinkingToggle } from "./ThinkingToggle";
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

interface ChatPanelProps {
  onSignInClick?: () => void;
}

interface ChatPanelComponent extends Component<ChatPanelProps> {
  focusInput?: () => void;
}

export const ChatPanel: Component<ChatPanelProps> = (_props) => {
  const [input, setInput] = createSignal("");
  const [streamingSession, setStreamingSession] =
    createSignal<ActiveStreamingSession | null>(null);
  const [suggestions, setSuggestions] = createSignal<Publisher[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = createSignal(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = createSignal(false);
  // Balance error state for friendly warning display
  const [balanceError, setBalanceError] = createSignal<BalanceInfo | null>(
    null,
  );
  // Input history navigation (terminal-style up/down arrow)
  const [historyIndex, setHistoryIndex] = createSignal(-1); // -1 = not browsing history
  const [savedInput, setSavedInput] = createSignal(""); // save current input before browsing
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
    // Register keyboard shortcuts
    document.addEventListener("keydown", handleKeyDown);

    // Register copy button handler (event delegation)
    messagesRef?.addEventListener("click", handleCopyClick);

    try {
      await chatStore.loadHistory();
    } catch (error) {
      chatStore.setError((error as Error).message);
    }
  });

  // Auto-scroll to bottom when messages change or streaming starts
  createEffect(() => {
    // Track both messages array and streaming session
    void chatStore.messages;
    void streamingSession();
    // Scroll after render
    requestAnimationFrame(scrollToBottom);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
    messagesRef?.removeEventListener("click", handleCopyClick);
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
        const updatedNodes = updateNodeChildren(
          fileTreeState.nodes,
          path,
          children,
        );
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

  // User message history for up/down arrow navigation (most recent first)
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

    // Use tool-aware streaming if tools are available (Seren provider)
    const useTools = areToolsAvailable();
    const session: ActiveStreamingSession = useTools
      ? {
          id: assistantId,
          userMessageId: userMessage.id,
          prompt: trimmed,
          model: chatStore.selectedModel,
          context,
          stream: streamMessageWithTools(
            trimmed,
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
          prompt: trimmed,
          model: chatStore.selectedModel,
          context,
          stream: streamMessage(trimmed, chatStore.selectedModel, context),
          toolsEnabled: false,
        };

    chatStore.setLoading(true);
    setStreamingSession(session);
    chatStore.setError(null);
    setBalanceError(null); // Clear any previous balance warning
    setInput("");
    // Reset history navigation state
    setHistoryIndex(-1);
    setSavedInput("");
  };

  const handleStreamingComplete = async (
    session: ActiveStreamingSession,
    content: string,
    thinking?: string,
  ) => {
    const assistantMessage: Message = {
      id: session.id,
      role: "assistant",
      content,
      thinking,
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

  const handleStreamingError = async (
    session: ActiveStreamingSession,
    error: Error,
  ) => {
    setStreamingSession(null);
    chatStore.setLoading(false);

    // Check if this is a balance error - show friendly warning instead of ugly JSON
    if (isBalanceError(error.message)) {
      const balanceInfo = parseBalanceError(error.message);
      setBalanceError(balanceInfo);
      // Don't set the raw error message for balance errors
      chatStore.setError(null);
      // Don't add a failed message for balance errors - just show the warning
      return;
    }

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
    <section class="flex flex-row h-full bg-[#0d1117] text-[#e6edf3]">
      {/* File Explorer Sidebar */}
      <aside class="w-60 min-w-[200px] max-w-[400px] flex flex-col bg-[#161b22] border-r border-[#21262d]">
        <div class="flex justify-between items-center px-3 py-2.5 border-b border-[#21262d] text-[11px] font-semibold uppercase tracking-wide text-[#8b949e]">
          <span>Explorer</span>
          <button
            type="button"
            onClick={handleOpenFolder}
            disabled={isLoadingFolder()}
            title="Open Folder"
            class="bg-transparent border-none text-[#8b949e] cursor-pointer px-1 py-0.5 text-sm leading-none transition-colors hover:text-[#e6edf3] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoadingFolder() ? "..." : "+"}
          </button>
        </div>
        <div class="flex-1 overflow-y-auto py-1">
          <FileTree
            onFileSelect={handleFileSelect}
            onDirectoryToggle={handleDirectoryToggle}
          />
        </div>
      </aside>

      {/* Main Chat Area */}
      <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Show
          when={authStore.isAuthenticated}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center gap-6 p-10">
              <div class="text-center max-w-[360px]">
                <h2 class="m-0 mb-2 text-lg font-semibold text-[#e6edf3]">
                  Sign in to chat
                </h2>
                <p class="m-0 text-sm text-[#8b949e] leading-normal">
                  Connect with Seren to access AI-powered conversations and code
                  assistance.
                </p>
              </div>
              <SignIn onSuccess={() => checkAuth()} />
            </div>
          }
        >
          <ChatTabBar />
          <header class="shrink-0 flex justify-between items-center px-4 py-3 border-b border-[#21262d] bg-[#161b22]">
            <div class="flex items-center gap-3">
              <AgentModeToggle />
            </div>
            <div class="flex gap-2 items-center">
              <Show when={!acpStore.agentModeEnabled}>
                <ThinkingToggle />
                <button
                  type="button"
                  class="bg-transparent border border-[#30363d] text-[#8b949e] px-3 py-1 rounded-md text-xs cursor-pointer transition-all hover:bg-[#21262d] hover:text-[#e6edf3] hover:border-[#484f58]"
                  onClick={clearHistory}
                >
                  Clear
                </button>
              </Show>
            </div>
          </header>

          {/* Conditional rendering: Agent mode vs Chat mode */}
          <Show
            when={acpStore.agentModeEnabled}
            fallback={
              <>
                <div
                  class="flex-1 min-h-0 overflow-y-auto pb-4 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[#30363d] [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb:hover]:bg-[#484f58]"
                  ref={messagesRef}
                >
                  <Show
                    when={chatStore.messages.length > 0}
                    fallback={
                      <div class="flex-1 flex flex-col items-center justify-center p-10 text-[#8b949e]">
                        <h3 class="m-0 mb-2 text-base font-medium text-[#e6edf3]">
                          Start a conversation
                        </h3>
                        <p class="m-0 text-sm text-center max-w-[280px]">
                          Ask questions about code, get explanations, or request
                          help with programming tasks.
                        </p>
                      </div>
                    }
                  >
                    <For each={chatStore.messages}>
                      {(message) => (
                        <article
                          class={`px-5 py-4 border-b border-[#21262d] last:border-b-0 ${message.role === "user" ? "bg-[#161b22]" : "bg-transparent"}`}
                        >
                          <Show
                            when={
                              message.role === "assistant" &&
                              message.thinking &&
                              settingsStore.get("chatShowThinking")
                            }
                          >
                            <ThinkingBlock thinking={message.thinking ?? ""} />
                          </Show>
                          <div
                            class="text-sm leading-relaxed text-[#e6edf3] break-words [&_p]:m-0 [&_p]:mb-3 [&_p:last-child]:mb-0 [&_code]:bg-[#21262d] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-mono [&_code]:text-[13px] [&_pre]:bg-[#161b22] [&_pre]:border [&_pre]:border-[#30363d] [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[13px] [&_pre_code]:leading-normal [&_ul]:my-2 [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:pl-6 [&_li]:my-1 [&_blockquote]:border-l-[3px] [&_blockquote]:border-[#30363d] [&_blockquote]:my-3 [&_blockquote]:pl-4 [&_blockquote]:text-[#8b949e] [&_a]:text-[#58a6ff] [&_a]:no-underline [&_a:hover]:underline"
                            innerHTML={
                              message.role === "assistant"
                                ? renderMarkdown(message.content)
                                : escapeHtml(message.content)
                            }
                          />
                          <Show when={message.status === "error"}>
                            <div class="mt-3 px-3 py-2 bg-[rgba(248,81,73,0.1)] border border-[rgba(248,81,73,0.4)] rounded-md flex items-center gap-3 text-[13px] text-[#f85149]">
                              <span>{message.error ?? "Message failed"}</span>
                              <Show
                                when={
                                  chatStore.retryingMessageId === message.id
                                }
                              >
                                <span>
                                  Retrying (
                                  {Math.min(
                                    message.attemptCount ?? 1,
                                    CHAT_MAX_RETRIES,
                                  )}
                                  /{CHAT_MAX_RETRIES})…
                                </span>
                              </Show>
                              <Show when={message.request}>
                                <button
                                  type="button"
                                  class="bg-transparent border border-[rgba(248,81,73,0.4)] text-[#f85149] px-2.5 py-1 rounded text-xs cursor-pointer hover:bg-[rgba(248,81,73,0.15)]"
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
                      // Capture session immediately to avoid stale accessor in callbacks
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
                              onError={(error) =>
                                handleStreamingError(session, error)
                              }
                              onContentUpdate={scrollToBottom}
                            />
                          }
                        >
                          <ToolStreamingMessage
                            stream={(session as ToolStreamingSession).stream}
                            onComplete={(content, thinking) =>
                              handleStreamingComplete(
                                session,
                                content,
                                thinking,
                              )
                            }
                            onError={(error) =>
                              handleStreamingError(session, error)
                            }
                            onContentUpdate={scrollToBottom}
                          />
                        </Show>
                      );
                    }}
                  </Show>

                  {/* Balance warning for insufficient funds */}
                  <Show when={balanceError()}>
                    {(info) => (
                      <BalanceWarning
                        balanceInfo={info()}
                        onDismiss={() => setBalanceError(null)}
                      />
                    )}
                  </Show>
                </div>

                <Show when={contextPreview()}>
                  {(ctx) => (
                    <div class="mx-4 my-3 bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
                      <div class="flex justify-between items-center px-3 py-2 bg-[#21262d] text-xs text-[#8b949e]">
                        <span>
                          Context from {ctx().file ?? "selection"}
                          {ctx().range &&
                            ` (${ctx().range?.startLine}-${ctx().range?.endLine})`}
                        </span>
                        <button
                          type="button"
                          class="bg-transparent border-none text-[#8b949e] cursor-pointer px-1.5 py-0.5 text-sm leading-none hover:text-[#e6edf3]"
                          onClick={() => editorStore.clearSelection()}
                        >
                          ×
                        </button>
                      </div>
                      <pre class="m-0 p-3 max-h-[120px] overflow-y-auto text-xs leading-normal bg-transparent">
                        {ctx().text}
                      </pre>
                    </div>
                  )}
                </Show>

                <div class="shrink-0 p-4 border-t border-[#21262d] bg-[#161b22]">
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
                    <textarea
                      ref={inputRef}
                      value={input()}
                      placeholder="Ask Seren anything…"
                      class="w-full min-h-[80px] max-h-[50vh] resize-y bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] p-3 font-inherit text-sm leading-normal transition-colors focus:outline-none focus:border-[#58a6ff] placeholder:text-[#484f58] disabled:opacity-60 disabled:cursor-not-allowed"
                      onInput={(event) => {
                        setInput(event.currentTarget.value);
                        // Reset history browsing when user types manually
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
                          // Only trigger if cursor at start or input empty
                          if (textarea.selectionStart === 0 || input() === "") {
                            event.preventDefault();

                            if (historyIndex() === -1) {
                              // Starting to browse - save current input
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
                          // Only trigger if cursor at end
                          if (
                            textarea.selectionStart === textarea.value.length
                          ) {
                            event.preventDefault();

                            const newIndex = historyIndex() - 1;
                            setHistoryIndex(newIndex);

                            if (newIndex < 0) {
                              // Back to current input
                              setInput(savedInput());
                              setSavedInput("");
                            } else {
                              setInput(history[newIndex]);
                            }
                          }
                        }

                        // Enter key handling
                        if (event.key === "Enter") {
                          const enterToSend =
                            settingsStore.get("chatEnterToSend");
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
                    <div class="flex justify-between items-center">
                      <div class="flex items-center gap-3">
                        <ModelSelector />
                        <span class="text-xs text-[#484f58]">
                          {settingsStore.get("chatEnterToSend")
                            ? "Enter to send"
                            : "Ctrl+Enter to send"}
                        </span>
                      </div>
                      <button
                        type="submit"
                        class="bg-[#238636] text-white border-none px-4 py-1.5 rounded-md text-[13px] font-medium cursor-pointer transition-colors hover:bg-[#2ea043] disabled:bg-[#21262d] disabled:text-[#484f58] disabled:cursor-not-allowed"
                        disabled={chatStore.isLoading}
                      >
                        Send
                      </button>
                    </div>
                  </form>
                </div>
              </>
            }
          >
            <AgentChat />
          </Show>
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
  children: typeof fileTreeState.nodes,
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
