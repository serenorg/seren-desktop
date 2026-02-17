// ABOUTME: Chat interface for agent mode, displaying agent messages, tool calls, and diffs.
// ABOUTME: Handles agent session lifecycle and message streaming.

import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { AcpPermissionDialog } from "@/components/acp/AcpPermissionDialog";
import { DiffProposalDialog } from "@/components/acp/DiffProposalDialog";
import { VoiceInputButton } from "@/components/chat/VoiceInputButton";
import { ResizableTextarea } from "@/components/common/ResizableTextarea";
import { isAuthError } from "@/lib/auth-errors";
import { getCompletions, parseCommand } from "@/lib/commands/parser";
import type { CommandContext } from "@/lib/commands/types";
import { API_BASE } from "@/lib/config";
import { openExternalLink } from "@/lib/external-link";
import { appFetch } from "@/lib/fetch";
import { formatDurationWithVerb } from "@/lib/format-duration";
import { pickAndReadAttachments } from "@/lib/images/attachments";
import type { Attachment } from "@/lib/providers/types";
import {
  getModelDisplayName,
  mapAgentModelToChat,
} from "@/lib/rate-limit-fallback";
import { escapeHtmlWithLinks, renderMarkdown } from "@/lib/render-markdown";
import { type AgentType, type DiffEvent, launchLogin } from "@/services/acp";
import { getToken } from "@/services/auth";
import { type AgentMessage, acpStore } from "@/stores/acp.store";
import { fileTreeState } from "@/stores/fileTree";
import { settingsStore } from "@/stores/settings.store";
import { threadStore } from "@/stores/thread.store";
import { AgentEffortSelector } from "./AgentEffortSelector";
import { AgentModelSelector } from "./AgentModelSelector";
import { AgentModeSelector } from "./AgentModeSelector";
import { DiffCard } from "./DiffCard";
import { ImageAttachmentBar } from "./ImageAttachmentBar";
import { PlanHeader } from "./PlanHeader";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { ThinkingBlock } from "./ThinkingBlock";
import { ThinkingStatus } from "./ThinkingStatus";
import { ToolCallCard } from "./ToolCallCard";
import { ToolCallGroup } from "./ToolCallGroup";

interface AgentChatProps {
  onViewDiff?: (diff: DiffEvent) => void;
}

export const AgentChat: Component<AgentChatProps> = (props) => {
  const [input, setInput] = createSignal("");
  const [messageQueue, setMessageQueue] = createSignal<string[]>([]);
  const [attachedImages, setAttachedImages] = createSignal<Attachment[]>([]);
  const [commandStatus, setCommandStatus] = createSignal<string | null>(null);
  const [commandPopupIndex, setCommandPopupIndex] = createSignal(0);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [savedInput, setSavedInput] = createSignal("");
  const [isAttaching, setIsAttaching] = createSignal(false);
  const [awaitingLogin, setAwaitingLogin] = createSignal<AgentType | null>(
    null,
  );
  let inputRef: HTMLTextAreaElement | undefined;
  let messagesRef: HTMLDivElement | undefined;

  // Get the active agent thread (must be defined before thread-specific memos)
  const activeAgentThread = createMemo(() => {
    const thread = threadStore.activeThread;
    if (!thread || thread.kind !== "agent") return null;
    return thread;
  });

  // Get messages for THIS thread's conversation ID, not the active session
  const threadMessages = createMemo(() => {
    const thread = activeAgentThread();
    if (!thread) return [];
    return acpStore.getMessagesForConversation(thread.id);
  });

  // Get streaming content for THIS thread's conversation ID
  const threadStreamingContent = createMemo(() => {
    const thread = activeAgentThread();
    if (!thread) return "";
    return acpStore.getStreamingContentForConversation(thread.id);
  });

  // Get streaming thinking for THIS thread's conversation ID
  const threadStreamingThinking = createMemo(() => {
    const thread = activeAgentThread();
    if (!thread) return "";
    return acpStore.getStreamingThinkingForConversation(thread.id);
  });

  // Build reversed list of user prompts for Up/Down arrow navigation
  const userMessageHistory = createMemo(() =>
    threadMessages()
      .filter((m) => m.type === "user")
      .map((m) => m.content)
      .reverse(),
  );

  const onPickImages = () => handleAttachImages();
  const onSetChatInput = (event: Event) => {
    const customEvent = event as CustomEvent<
      string | { text: string; autoSend?: boolean }
    >;
    const detail = customEvent.detail;

    // Support both string (legacy) and object format
    if (typeof detail === "string") {
      setInput(detail);
      inputRef?.focus();
    } else if (detail && typeof detail === "object") {
      setInput(detail.text);
      inputRef?.focus();

      // Auto-send if requested (e.g., from skill click)
      if (detail.autoSend) {
        // Use setTimeout to ensure input is set before sending
        setTimeout(() => {
          sendMessage();
        }, 0);
      }
    }
  };
  onMount(() => {
    window.addEventListener("seren:pick-images", onPickImages);
    window.addEventListener("seren:set-chat-input", onSetChatInput);
    if (fileTreeState.rootPath) {
      void acpStore.refreshRemoteSessions(
        fileTreeState.rootPath,
        acpStore.selectedAgentType,
      );
    }
  });
  onCleanup(() => {
    window.removeEventListener("seren:pick-images", onPickImages);
    window.removeEventListener("seren:set-chat-input", onSetChatInput);
  });

  const hasSession = () => acpStore.activeSession !== null;
  const isReady = () => acpStore.activeSession?.info.status === "ready";
  const isPrompting = () => acpStore.activeSession?.info.status === "prompting";
  const sessionError = () => acpStore.error;
  const lockedAgentType = createMemo<AgentType>(() => {
    const sessionAgent = acpStore.activeSession?.info.agentType;
    if (sessionAgent === "codex" || sessionAgent === "claude-code") {
      return sessionAgent;
    }
    return activeAgentThread()?.agentType === "codex" ? "codex" : "claude-code";
  });
  const lockedAgentName = () =>
    lockedAgentType() === "codex" ? "Codex" : "Claude Code";

  // Get the current working directory from file tree
  const getCwd = () => {
    return fileTreeState.rootPath || null;
  };

  const hasFolderOpen = () => Boolean(fileTreeState.rootPath);

  // Refresh project-scoped remote sessions (agent source-of-truth) and focus
  // any live session tied to the selected folder.
  // Skip refresh if a prompt is active to avoid backend rejection.
  createEffect(
    on(
      () => [fileTreeState.rootPath, lockedAgentType()] as const,
      ([newPath, agentType]) => {
        if (newPath && !isPrompting()) {
          void acpStore.refreshRemoteSessions(newPath, agentType);
          // Only auto-focus a project session if there's no active session
          // or if the active session belongs to a different project.
          // This prevents overriding explicit user thread selections.
          const activeSession = acpStore.activeSession;
          if (!activeSession || activeSession.cwd !== newPath) {
            acpStore.focusProjectSession(newPath);
          }
        }
      },
      { defer: true },
    ),
  );

  const scrollToBottom = () => {
    if (messagesRef) {
      messagesRef.scrollTop = messagesRef.scrollHeight;
    }
  };

  // Auto-scroll when messages change or permission dialogs appear
  createEffect(() => {
    const messages = threadMessages();
    const streaming = threadStreamingContent();
    const permissions = acpStore.pendingPermissions;
    const diffProposals = acpStore.pendingDiffProposals;
    console.log("[AgentChat] Effect triggered:", {
      messagesCount: messages.length,
      streamingLength: streaming.length,
      streamingPreview: streaming.slice(0, 100),
      pendingPermissions: permissions.length,
      pendingDiffProposals: diffProposals.length,
    });
    requestAnimationFrame(scrollToBottom);
  });

  // Clear "awaiting login" banner once a session starts
  createEffect(() => {
    if (hasSession()) setAwaitingLogin(null);
  });

  const startSession = async (agentType: AgentType = lockedAgentType()) => {
    const cwd = getCwd();
    if (!cwd) {
      console.warn("[AgentChat] No folder open, cannot start session");
      return;
    }
    console.log("[AgentChat] Starting session with cwd:", cwd);
    try {
      const sessionId = await acpStore.spawnSession(cwd, agentType);
      console.log("[AgentChat] Session started:", sessionId);
    } catch (error) {
      console.error("[AgentChat] Failed to start session:", error);
    }
  };

  const retrySessionConnection = () => {
    const thread = activeAgentThread();
    if (!thread) return;
    threadStore.selectThread(thread.id, "agent");
  };

  const handleAttachImages = async () => {
    console.log(
      "[AgentChat] handleAttachImages called, hasSession:",
      hasSession(),
    );

    // Prevent multiple concurrent attach operations
    if (isAttaching()) {
      console.log("[AgentChat] Already attaching, skipping");
      return;
    }

    setIsAttaching(true);
    try {
      const files = await pickAndReadAttachments();
      console.log(
        "[AgentChat] pickAndReadAttachments returned:",
        files.length,
        "files",
        files.map((f) => f.name),
      );
      if (files.length > 0) {
        setAttachedImages((prev) => {
          const newAttachments = [...prev, ...files];
          console.log(
            "[AgentChat] Updating attachedImages, prev:",
            prev.length,
            "adding:",
            files.length,
            "total:",
            newAttachments.length,
          );
          return newAttachments;
        });
        // Log the current state after the update
        console.log(
          "[AgentChat] attachedImages after update:",
          attachedImages().length,
        );
      } else {
        console.log("[AgentChat] No files selected or dialog cancelled");
      }
    } catch (error) {
      console.error("[AgentChat] handleAttachImages error:", error);
      // Show error status to user
      setCommandStatus(
        `Failed to attach files: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setTimeout(() => setCommandStatus(null), 5000);
    } finally {
      setIsAttaching(false);
    }
  };

  const handleRemoveImage = (index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const copyAllChatHistory = async () => {
    const messages = threadMessages();
    if (messages.length === 0) {
      alert("No chat history to copy");
      return;
    }

    // Format messages as markdown
    let markdown = "# Agent Chat History\n\n";
    for (const msg of messages) {
      if (msg.type === "user") {
        markdown += `**You:** ${msg.content}\n\n`;
      } else if (msg.type === "assistant") {
        markdown += `**Agent:** ${msg.content}\n\n`;
      }
    }

    try {
      await navigator.clipboard.writeText(markdown);
      alert("Chat history copied to clipboard!");
    } catch (error) {
      console.error("Failed to copy:", error);
      alert("Failed to copy chat history");
    }
  };

  const downloadChatHistory = async () => {
    const messages = threadMessages();
    if (messages.length === 0) return;

    const dateStr = new Date().toISOString().split("T")[0];
    const title = `Agent Chat History - ${dateStr}`;

    let markdown = "# Agent Chat History\n\n";
    markdown += `*Exported ${new Date().toLocaleString()}*\n\n---\n\n`;
    for (const msg of messages) {
      if (msg.type === "user") {
        markdown += `**You:** ${msg.content}\n\n`;
      } else if (msg.type === "assistant") {
        markdown += `**Agent:** ${msg.content}\n\n`;
      }
    }

    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");

      const response = await appFetch(
        `${API_BASE}/publishers/seren-notes/notes`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            title,
            content: markdown,
            format: "markdown",
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Notes API returned ${response.status}`);
      }

      const result = await response.json();
      const noteId = result?.body?.data?.id ?? result?.data?.id;
      if (noteId) {
        openExternalLink(`https://notes.serendb.com/_authed/notes/${noteId}`);
      } else {
        throw new Error("Note created but ID missing from response");
      }
    } catch (error) {
      console.error("[AgentChat] Failed to save to Seren Notes:", error);
      alert("Failed to save to Seren Notes. Are you logged in?");
    }
  };

  const clearHistory = async () => {
    const confirmClear = window.confirm(
      "Clear all agent chat history for this session?",
    );
    if (!confirmClear) return;

    const session = acpStore.activeSession;
    if (!session) return;

    // Clear messages in the active session
    acpStore.clearSessionMessages(session.info.id);
  };

  const compactConversation = async (preserveCount: number) => {
    const messages = threadMessages();
    if (messages.length <= preserveCount) {
      alert("Not enough messages to compact");
      return;
    }

    const confirmCompact = window.confirm(
      `Compact older messages, preserving the most recent ${preserveCount}?`,
    );
    if (!confirmCompact) return;

    // For now, show a message that this feature is coming soon
    // TODO: Implement agent conversation compaction
    alert("Agent conversation compaction coming soon!");
  };

  const executeSlashCommand = (trimmed: string) => {
    const parsed = parseCommand(trimmed, "agent");
    if (!parsed) return false;

    const ctx: CommandContext = {
      rawInput: trimmed,
      args: parsed.args,
      panel: "agent",
      clearInput: () => setInput(""),
      openPanel: (panel: string) => {
        window.dispatchEvent(
          new CustomEvent("seren:open-panel", { detail: panel }),
        );
      },
      showStatus: (message: string) => {
        setCommandStatus(message);
        setTimeout(() => setCommandStatus(null), 4000);
      },
    };

    parsed.command.execute(ctx);
    setCommandPopupIndex(0);
    return true;
  };

  const sendMessage = async () => {
    const trimmed = input().trim();
    const images = attachedImages();
    if (!hasSession()) return;

    // Require text content even when images are attached
    if (!trimmed) {
      if (images.length > 0) {
        setCommandStatus(
          "Please add text to your message. Image-only messages are not supported.",
        );
        setTimeout(() => setCommandStatus(null), 4000);
      }
      return;
    }

    // Check for slash commands first
    if (trimmed.startsWith("/") && images.length === 0) {
      if (executeSlashCommand(trimmed)) return;
    }

    // If agent is prompting, queue the message instead
    if (isPrompting()) {
      setMessageQueue((queue) => [...queue, trimmed]);
      setInput("");
      console.log("[AgentChat] Message queued:", trimmed);
      return;
    }

    // Build context with images as ACP image content blocks
    const context: Array<Record<string, string>> | undefined =
      images.length > 0
        ? images.map((img) => ({
            type: "image",
            data: img.base64,
            mimeType: img.mimeType,
          }))
        : undefined;

    setInput("");
    setAttachedImages([]);
    setHistoryIndex(-1);
    setSavedInput("");
    await acpStore.sendPrompt(trimmed, context);
  };

  // Process queued messages when agent becomes ready
  // Use on() to only fire when isReady transitions from false→true
  // This prevents the effect from firing multiple times for multiple queued messages
  createEffect(
    on(
      isReady,
      (ready) => {
        if (ready && messageQueue().length > 0) {
          const [nextMessage, ...remaining] = messageQueue();
          setMessageQueue(remaining);
          console.log("[AgentChat] Processing queued message:", nextMessage);
          // Send without delay - the on() guard ensures this only fires once per ready transition
          acpStore.sendPrompt(nextMessage);
        }
      },
      { defer: true },
    ),
  );

  const handleCancel = async () => {
    // Clear queued messages so they don't auto-send after cancellation
    setMessageQueue([]);
    await acpStore.cancelPrompt();
  };

  const handleGlobalKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && isPrompting()) {
      event.preventDefault();
      handleCancel();
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleGlobalKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleGlobalKeyDown);
  });

  const handleKeyDown = (event: KeyboardEvent) => {
    // Slash command popup keyboard navigation
    const isSlashInput = input().startsWith("/") && !input().includes(" ");
    if (isSlashInput) {
      const matches = getCompletions(input(), "agent");
      if (matches.length > 0) {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setCommandPopupIndex((i) => (i > 0 ? i - 1 : matches.length - 1));
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setCommandPopupIndex((i) => (i < matches.length - 1 ? i + 1 : 0));
          return;
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          const selected = matches[commandPopupIndex()];
          if (selected) {
            if (event.key === "Tab" || selected.argHint) {
              setInput(`/${selected.name} `);
            } else {
              executeSlashCommand(`/${selected.name}`);
            }
            setCommandPopupIndex(0);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setInput("");
          return;
        }
      }
    }

    // Up arrow: navigate to older prompts
    const history = userMessageHistory();
    if (event.key === "ArrowUp" && history.length > 0) {
      const textarea = event.currentTarget as HTMLTextAreaElement;
      if (textarea.selectionStart === 0 || input() === "") {
        event.preventDefault();
        if (historyIndex() === -1) {
          setSavedInput(input());
        }
        const newIndex = Math.min(historyIndex() + 1, history.length - 1);
        setHistoryIndex(newIndex);
        setInput(history[newIndex]);
      }
    }

    // Down arrow: navigate to newer prompts
    if (event.key === "ArrowDown" && historyIndex() >= 0) {
      const textarea = event.currentTarget as HTMLTextAreaElement;
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

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  type GroupedMessage =
    | { type: "single"; message: AgentMessage }
    | {
        type: "tool_group";
        messages: AgentMessage[];
        toolCalls: ToolCallEvent[];
      };

  /** Group consecutive tool messages into collapsed groups */
  const groupConsecutiveToolCalls = createMemo(() => {
    const messages = threadMessages();
    const grouped: GroupedMessage[] = [];
    let currentGroup: AgentMessage[] = [];

    for (const message of messages) {
      if (message.type === "tool" && message.toolCall) {
        // Add to current group
        currentGroup.push(message);
      } else {
        // Flush current group if any
        if (currentGroup.length > 0) {
          if (currentGroup.length >= 3) {
            // Group 3+ consecutive tool calls
            grouped.push({
              type: "tool_group",
              messages: currentGroup,
              toolCalls: currentGroup
                .filter((m) => m.toolCall)
                .map((m) => m.toolCall as ToolCallEvent),
            });
          } else {
            // Show individual cards for 1-2 tool calls
            for (const msg of currentGroup) {
              grouped.push({ type: "single", message: msg });
            }
          }
          currentGroup = [];
        }
        // Add non-tool message
        grouped.push({ type: "single", message });
      }
    }

    // Flush remaining group
    if (currentGroup.length > 0) {
      if (currentGroup.length >= 3) {
        grouped.push({
          type: "tool_group",
          messages: currentGroup,
          toolCalls: currentGroup
            .filter((m) => m.toolCall)
            .map((m) => m.toolCall as ToolCallEvent),
        });
      } else {
        for (const msg of currentGroup) {
          grouped.push({ type: "single", message: msg });
        }
      }
    }

    return grouped;
  });

  const renderMessage = (message: AgentMessage) => {
    switch (message.type) {
      case "user":
        return (
          <article class="px-5 py-4 bg-surface-1 border-b border-surface-2">
            <div
              class="text-sm leading-relaxed text-foreground whitespace-pre-wrap"
              innerHTML={escapeHtmlWithLinks(message.content)}
            />
          </article>
        );

      case "assistant":
        return (
          <article class="px-5 py-4 border-b border-surface-2">
            <div
              class="text-sm leading-relaxed text-foreground break-words [&_p]:m-0 [&_p]:mb-3 [&_p:last-child]:mb-0 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-2 [&_h4]:mb-1 [&_code]:bg-surface-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-mono [&_code]:text-[13px] [&_pre]:bg-surface-1 [&_pre]:border [&_pre]:border-border [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[13px] [&_pre_code]:leading-normal [&_ul]:my-2 [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:pl-6 [&_li]:my-1 [&_blockquote]:border-l-[3px] [&_blockquote]:border-border [&_blockquote]:my-3 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:no-underline [&_a:hover]:underline"
              innerHTML={renderMarkdown(message.content)}
            />
            <Show when={message.duration}>
              {(() => {
                const { verb, duration, costDisplay } = formatDurationWithVerb(
                  message.duration ?? 0,
                  message.cost,
                );
                return (
                  <div class="mt-2 text-xs text-muted-foreground">
                    ✻ {verb} for {duration}
                    {costDisplay && ` at ${costDisplay}`}
                  </div>
                );
              })()}
            </Show>
          </article>
        );

      case "thought":
        return (
          <article class="px-5 py-3 border-b border-surface-2">
            <ThinkingBlock thinking={message.content} />
          </article>
        );

      case "tool":
        return message.toolCall ? (
          <div class="px-5 py-2">
            <ToolCallCard toolCall={message.toolCall} />
          </div>
        ) : null;

      case "diff":
        return message.diff ? (
          <div class="px-5 py-2">
            <DiffCard diff={message.diff} onViewInEditor={props.onViewDiff} />
          </div>
        ) : null;

      case "error":
        return (
          <article class="px-5 py-3 border-b border-surface-2">
            <div
              class={`px-3 py-2 border rounded-md text-sm ${
                isAuthError(message.content)
                  ? "bg-warning/10 border-warning/40 text-warning"
                  : "bg-destructive/10 border-destructive/40 text-destructive"
              }`}
            >
              <Show
                when={isAuthError(message.content)}
                fallback={<span>{message.content}</span>}
              >
                <div class="flex items-center justify-between gap-2">
                  <span>
                    Authentication expired. Please log in to continue.
                  </span>
                  <button
                    type="button"
                    class="px-2 py-1 text-xs font-medium bg-warning text-background rounded hover:brightness-110 flex-shrink-0"
                    onClick={async () => {
                      const agentType =
                        acpStore.activeSession?.info.agentType ?? "claude-code";
                      if (agentType !== "codex") {
                        launchLogin(agentType);
                      }
                      const sid = acpStore.activeSessionId;
                      if (sid) {
                        await acpStore.terminateSession(sid);
                      }
                      acpStore.clearError();
                      setAwaitingLogin(agentType);
                    }}
                  >
                    Login
                  </button>
                </div>
              </Show>
            </div>
          </article>
        );

      default:
        return null;
    }
  };

  return (
    <div class="flex-1 flex flex-col min-h-0">
      {/* Plan Header */}
      <PlanHeader />

      {/* Action Buttons Header */}
      <Show when={threadMessages().length > 0}>
        <div class="flex items-center justify-end gap-2 px-4 py-2 border-b border-surface-3">
          <button
            type="button"
            class="bg-transparent border border-border text-muted-foreground px-2 py-1 rounded text-xs cursor-pointer transition-all hover:bg-surface-2 hover:text-foreground"
            onClick={() =>
              compactConversation(
                settingsStore.get("autoCompactPreserveMessages"),
              )
            }
            title="Compact older messages"
          >
            Compact
          </button>
          <button
            type="button"
            class="bg-transparent border border-border text-muted-foreground p-1.5 rounded text-xs cursor-pointer transition-all hover:bg-surface-2 hover:text-foreground"
            onClick={copyAllChatHistory}
            title="Copy all chat history"
          >
            <svg
              class="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              role="img"
              aria-label="Copy"
            >
              <title>Copy chat history</title>
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </button>
          <button
            type="button"
            class="bg-transparent border border-border text-muted-foreground p-1.5 rounded text-xs cursor-pointer transition-all hover:bg-surface-2 hover:text-foreground"
            onClick={downloadChatHistory}
            title="Download chat history"
          >
            <svg
              class="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              role="img"
              aria-label="Download"
            >
              <title>Download chat history</title>
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
          </button>
          <button
            type="button"
            class="bg-transparent border border-border text-muted-foreground px-2 py-1 rounded text-xs cursor-pointer transition-all hover:bg-surface-2 hover:text-foreground"
            onClick={clearHistory}
          >
            Clear
          </button>
        </div>
      </Show>

      {/* Messages Area */}
      <div
        ref={messagesRef}
        class="flex-1 min-h-0 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-surface-3 [&::-webkit-scrollbar-thumb]:rounded"
        onClick={(e) => {
          const target = e.target as HTMLElement;
          const link = target.closest(".external-link") as HTMLAnchorElement;
          if (link) {
            e.preventDefault();
            const url = link.dataset.externalUrl;
            if (url) openExternalLink(url);
            return;
          }
          const copyBtn = target.closest(".code-copy-btn") as HTMLElement;
          if (copyBtn) {
            const code = copyBtn.dataset.code;
            if (code) {
              navigator.clipboard.writeText(code);
              const original = copyBtn.innerHTML;
              copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg> Copied!`;
              copyBtn.classList.add("copied");
              setTimeout(() => {
                copyBtn.innerHTML = original;
                copyBtn.classList.remove("copied");
              }, 2000);
            }
          }
        }}
      >
        <Show
          when={hasSession()}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center p-10 text-muted-foreground">
              <div class="max-w-[320px] text-center">
                <svg
                  class="w-12 h-12 mx-auto mb-4 text-surface-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  role="img"
                  aria-label="Computer"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1.5"
                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
                <h3 class="m-0 mb-2 text-base font-medium text-foreground">
                  Reconnecting {lockedAgentName()} Thread
                </h3>
                <p class="m-0 mb-4 text-sm">
                  This conversation is locked to {lockedAgentName()}. Seren is
                  reattaching the session for this thread.
                </p>
                <div class="flex flex-col items-center gap-3 w-full max-w-md">
                  <Show when={lockedAgentType() === "claude-code"}>
                    <div class="w-full px-3 py-2 bg-primary/10 border border-primary/30 rounded-md text-xs text-primary">
                      <div class="flex items-start gap-2">
                        <svg
                          class="w-4 h-4 mt-0.5 flex-shrink-0"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                          role="img"
                          aria-label="Info"
                        >
                          <path
                            fill-rule="evenodd"
                            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                            clip-rule="evenodd"
                          />
                        </svg>
                        <span>
                          <strong>Claude Code Required:</strong> Make sure
                          Claude Code CLI is installed and run{" "}
                          <code>claude login</code> to authenticate.
                        </span>
                      </div>
                    </div>
                  </Show>
                  <Show when={!hasFolderOpen()}>
                    <div class="w-full px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-md text-xs text-destructive">
                      Open a folder first to set the agent's working directory.
                    </div>
                  </Show>
                  <button
                    type="button"
                    class="px-4 py-2 bg-success text-white rounded-md text-sm font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={retrySessionConnection}
                    disabled={acpStore.isLoading || !hasFolderOpen()}
                  >
                    {acpStore.isLoading
                      ? "Reconnecting..."
                      : "Retry Connection"}
                  </button>
                </div>
              </div>
            </div>
          }
        >
          {/* Session Messages */}
          <Show
            when={threadMessages().length > 0 || threadStreamingContent()}
            fallback={
              <div class="flex flex-col items-center justify-center p-10 text-muted-foreground">
                <h3 class="m-0 mb-2 text-base font-medium text-foreground">
                  Agent Ready
                </h3>
                <p class="m-0 text-sm text-center max-w-[280px]">
                  Describe what you'd like the agent to do. It can read files,
                  make edits, run commands, and more.
                </p>
              </div>
            }
          >
            <For each={groupConsecutiveToolCalls()}>
              {(item) => {
                if (item.type === "tool_group") {
                  return (
                    <ToolCallGroup
                      toolCalls={item.toolCalls}
                      isComplete={true}
                    />
                  );
                }
                return renderMessage(item.message);
              }}
            </For>

            {/* Loading placeholder while waiting for first chunk */}
            <Show
              when={
                isPrompting() &&
                !threadStreamingContent() &&
                !threadStreamingThinking()
              }
            >
              <article class="px-5 py-4 border-b border-surface-2">
                <ThinkingStatus />
              </article>
            </Show>

            {/* Streaming Thinking */}
            <Show when={threadStreamingThinking()}>
              <article class="px-5 py-3 border-b border-surface-2">
                <ThinkingBlock
                  thinking={threadStreamingThinking()}
                  isStreaming={true}
                />
              </article>
            </Show>

            {/* Streaming Content */}
            <Show when={threadStreamingContent()}>
              <article class="px-5 py-4 border-b border-surface-2">
                <div
                  class="text-sm leading-relaxed text-foreground break-words [&_p]:m-0 [&_p]:mb-3 [&_p:last-child]:mb-0 [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-2 [&_h4]:mb-1 [&_code]:bg-surface-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:font-mono [&_code]:text-[13px] [&_pre]:bg-surface-1 [&_pre]:border [&_pre]:border-border [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[13px] [&_pre_code]:leading-normal [&_ul]:my-2 [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:pl-6 [&_li]:my-1 [&_blockquote]:border-l-[3px] [&_blockquote]:border-border [&_blockquote]:my-3 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:no-underline [&_a:hover]:underline"
                  innerHTML={renderMarkdown(threadStreamingContent())}
                />
                <span class="inline-block w-2 h-4 ml-0.5 bg-primary animate-pulse" />
              </article>
            </Show>
          </Show>
        </Show>
      </div>

      {/* Permission and diff proposal dialogs — rendered outside the scroll
          container so they stay visible while the agent streams content. */}
      <Show
        when={
          acpStore.pendingDiffProposals.some(
            (p) => p.sessionId === acpStore.activeSessionId,
          ) ||
          acpStore.pendingPermissions.some(
            (p) => p.sessionId === acpStore.activeSessionId,
          )
        }
      >
        <div class="border-t border-border bg-background max-h-[40vh] overflow-y-auto">
          <For
            each={acpStore.pendingDiffProposals.filter(
              (p) => p.sessionId === acpStore.activeSessionId,
            )}
          >
            {(proposal) => (
              <div class="px-5 py-2">
                <DiffProposalDialog proposal={proposal} />
              </div>
            )}
          </For>
          <For
            each={acpStore.pendingPermissions.filter(
              (p) => p.sessionId === acpStore.activeSessionId,
            )}
          >
            {(perm) => (
              <div class="px-5 py-2">
                <AcpPermissionDialog permission={perm} />
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Agent Fallback Banner (rate limit or context window full) */}
      <Show when={acpStore.agentFallbackNeeded}>
        {(() => {
          const agentType =
            acpStore.activeSession?.info.agentType ?? "claude-code";
          const agentModelId = acpStore.activeSession?.currentModelId;
          const chatModelId = mapAgentModelToChat(agentModelId, agentType);
          const modelName = getModelDisplayName(chatModelId);
          const agentName = agentType === "codex" ? "Codex" : "Claude Code";
          const reason = acpStore.agentFallbackReason;
          const title =
            reason === "prompt_too_long"
              ? `${agentName}'s context window is full`
              : `${agentName} hit its rate limit`;
          const description =
            reason === "prompt_too_long"
              ? `Automatically switching to Chat mode with ${modelName}. Your conversation history will be preserved.`
              : `Automatically switching to Chat mode with ${modelName}. Your conversation history will be preserved.`;
          return (
            <div class="mx-4 mb-2 px-3 py-3 border rounded-md text-sm bg-primary/10 border-primary/40 text-primary">
              <div class="flex items-start gap-3">
                <svg
                  class="w-5 h-5 mt-0.5 flex-shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                  role="img"
                  aria-label="Info"
                >
                  <path
                    fill-rule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                    clip-rule="evenodd"
                  />
                </svg>
                <div class="flex-1">
                  <p class="m-0 mb-2 font-medium text-foreground">{title}</p>
                  <p class="m-0 text-xs text-muted-foreground">{description}</p>
                </div>
                <button
                  type="button"
                  class="px-2 py-1 text-xs font-medium bg-transparent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                  onClick={() => acpStore.dismissRateLimitPrompt()}
                  title="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })()}
      </Show>

      {/* Error Display */}
      <Show when={sessionError()}>
        <div
          class={`mx-4 mb-2 px-3 py-2 border rounded-md text-sm ${
            isAuthError(sessionError())
              ? "bg-warning/10 border-warning/40 text-warning"
              : "bg-destructive/10 border-destructive/40 text-destructive"
          }`}
        >
          <div class="flex items-center justify-between">
            <span class="flex-1">
              {isAuthError(sessionError())
                ? "Authentication expired. Please log in again to continue."
                : sessionError()}
            </span>
            <div class="flex items-center gap-2 ml-2">
              <Show when={isAuthError(sessionError())}>
                <button
                  type="button"
                  class="px-2 py-1 text-xs font-medium bg-warning text-background rounded hover:brightness-110"
                  onClick={async () => {
                    const agentType =
                      acpStore.activeSession?.info.agentType ?? "claude-code";
                    if (agentType !== "codex") {
                      launchLogin(agentType);
                    }
                    const sid = acpStore.activeSessionId;
                    if (sid) {
                      await acpStore.terminateSession(sid);
                    }
                    acpStore.clearError();
                    setAwaitingLogin(agentType);
                  }}
                >
                  Login
                </button>
              </Show>
              <Show
                when={
                  !isAuthError(sessionError()) &&
                  acpStore.activeSession?.info.status === "error"
                }
              >
                <button
                  type="button"
                  class="text-xs underline hover:no-underline"
                  onClick={async () => {
                    const sid = acpStore.activeSessionId;
                    if (sid) {
                      await acpStore.terminateSession(sid);
                    }
                    acpStore.clearError();
                    startSession();
                  }}
                >
                  Restart Session
                </button>
              </Show>
              <button
                type="button"
                class="text-xs underline hover:no-underline"
                onClick={() => acpStore.clearError()}
              >
                Dismiss
              </button>
            </div>
          </div>
          <Show when={isAuthError(sessionError())}>
            <p class="mt-1 text-xs opacity-80">
              Click "Login" to open authentication. Once complete, click "Start
              Session" to continue.
            </p>
          </Show>
        </div>
      </Show>

      {/* Awaiting Login Banner */}
      <Show when={awaitingLogin()}>
        <div class="mx-4 mb-2 px-3 py-2 border rounded-md text-sm bg-success/10 border-success/40 text-success">
          <div class="flex items-center justify-between">
            <span class="flex-1">
              Complete authentication in the opened window, then start a new
              session.
            </span>
            <div class="flex items-center gap-2 ml-2">
              <button
                type="button"
                class="px-2 py-1 text-xs font-medium bg-success text-background rounded hover:brightness-110"
                onClick={() => {
                  const agentType = awaitingLogin();
                  setAwaitingLogin(null);
                  if (agentType) startSession(agentType);
                }}
              >
                Start Session
              </button>
              <button
                type="button"
                class="text-xs underline hover:no-underline"
                onClick={() => setAwaitingLogin(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Agent CWD Display */}
      <Show when={hasSession() && acpStore.cwd}>
        <div class="shrink-0 px-4 py-1.5 border-t border-surface-2 bg-background flex items-center gap-2 text-xs text-muted-foreground">
          <svg
            class="w-3 h-3 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            role="img"
            aria-label="Folder"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          <span class="truncate" title={acpStore.cwd ?? ""}>
            {acpStore.cwd}
          </span>
        </div>
      </Show>

      {/* Input Area */}
      <Show when={hasSession()}>
        <div class="shrink-0 p-4 border-t border-surface-2 bg-surface-1">
          <form
            class="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
          >
            <ImageAttachmentBar
              images={attachedImages()}
              onAttach={handleAttachImages}
              onRemove={handleRemoveImage}
              isLoading={isAttaching()}
            />
            <div class="relative">
              <SlashCommandPopup
                input={input()}
                panel="agent"
                selectedIndex={commandPopupIndex()}
                onSelect={(cmd) => {
                  if (cmd.argHint) {
                    setInput(`/${cmd.name} `);
                    inputRef?.focus();
                  } else {
                    executeSlashCommand(`/${cmd.name}`);
                  }
                  setCommandPopupIndex(0);
                }}
              />
              <ResizableTextarea
                ref={(el) => (inputRef = el)}
                value={input()}
                placeholder={
                  isPrompting()
                    ? "Type to queue message..."
                    : "Tell the agent what to do… (type / for commands)"
                }
                class="w-full bg-background border border-border rounded-xl text-foreground px-3.5 py-3 font-inherit text-[14px] leading-normal transition-all duration-150 focus:outline-none focus:border-primary/60 focus:shadow-[var(--input-focus-glow)] placeholder:text-muted-foreground/60 disabled:opacity-60 disabled:cursor-not-allowed"
                minHeight={80}
                maxHeight={window.innerHeight * 0.5}
                onInput={(e) => {
                  setInput(e.currentTarget.value);
                  setCommandPopupIndex(0);
                }}
                onKeyDown={handleKeyDown}
                disabled={!hasSession()}
              />
            </div>
            <Show when={commandStatus()}>
              <div class="px-3 py-2 bg-surface-2 border border-border rounded-lg text-xs text-muted-foreground whitespace-pre-wrap">
                {commandStatus()}
              </div>
            </Show>
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-3">
                <span class="px-2 py-1 bg-surface-2 border border-surface-3 rounded-md text-xs text-foreground font-medium">
                  {lockedAgentName()}
                </span>
                <AgentModelSelector />
                <AgentModeSelector />
                <AgentEffortSelector />
                <Show when={isPrompting()}>
                  <ThinkingStatus />
                </Show>
                <Show when={messageQueue().length > 0}>
                  <span class="flex items-center gap-2 px-2 py-1 bg-surface-2 border border-border rounded text-xs text-muted-foreground">
                    {messageQueue().length} message
                    {messageQueue().length > 1 ? "s" : ""} queued
                    <button
                      type="button"
                      class="text-destructive hover:underline"
                      onClick={() => setMessageQueue([])}
                    >
                      Clear
                    </button>
                  </span>
                </Show>
              </div>
              <div class="flex items-center gap-2">
                <VoiceInputButton
                  mode="agent"
                  onTranscript={(text) => {
                    setInput((prev) => (prev ? `${prev} ${text}` : text));
                    if (settingsStore.get("voiceAutoSubmit")) {
                      sendMessage();
                    } else {
                      inputRef?.focus();
                    }
                  }}
                />
                <Show
                  when={isPrompting()}
                  fallback={
                    <button
                      type="submit"
                      class="px-4 py-1.5 bg-success text-white rounded-md text-[13px] font-medium hover:bg-emerald-700 transition-colors disabled:bg-surface-2 disabled:text-muted-foreground disabled:cursor-not-allowed"
                      disabled={!hasSession() || !input().trim()}
                    >
                      Send
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="px-4 py-1.5 bg-destructive text-white rounded-md text-[13px] font-medium hover:bg-destructive transition-colors"
                    onClick={handleCancel}
                  >
                    Cancel
                  </button>
                </Show>
              </div>
            </div>
          </form>
        </div>
      </Show>
    </div>
  );
};
