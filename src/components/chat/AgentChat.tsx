// ABOUTME: Chat interface for agent mode, displaying agent messages, tool calls, and diffs.
// ABOUTME: Handles agent session lifecycle and message streaming.

import type { Component } from "solid-js";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { DiffEvent } from "@/services/acp";
import { type AgentMessage, acpStore } from "@/stores/acp.store";
import { fileTreeState } from "@/stores/fileTree";
import { AgentSelector } from "./AgentSelector";
import { AgentTabBar } from "./AgentTabBar";
import { DiffCard } from "./DiffCard";
import { PlanHeader } from "./PlanHeader";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

interface AgentChatProps {
  onViewDiff?: (diff: DiffEvent) => void;
}

export const AgentChat: Component<AgentChatProps> = (props) => {
  const [input, setInput] = createSignal("");
  let inputRef: HTMLTextAreaElement | undefined;
  let messagesRef: HTMLDivElement | undefined;

  const hasSession = () => acpStore.activeSession !== null;
  const isReady = () => acpStore.activeSession?.info.status === "ready";
  const isPrompting = () => acpStore.activeSession?.info.status === "prompting";
  const sessionError = () => acpStore.error;

  // Get the current working directory from file tree
  const getCwd = () => {
    if (fileTreeState.rootPath) {
      return fileTreeState.rootPath;
    }
    // Fallback to current directory (agent will use its own cwd)
    return ".";
  };

  const scrollToBottom = () => {
    if (messagesRef) {
      messagesRef.scrollTop = messagesRef.scrollHeight;
    }
  };

  // Auto-scroll when messages change
  createEffect(() => {
    const messages = acpStore.messages;
    const streaming = acpStore.streamingContent;
    console.log("[AgentChat] Effect triggered:", {
      messagesCount: messages.length,
      streamingLength: streaming.length,
      streamingPreview: streaming.slice(0, 100),
    });
    requestAnimationFrame(scrollToBottom);
  });

  const startSession = async () => {
    const cwd = getCwd();
    console.log("[AgentChat] Starting session with cwd:", cwd);
    try {
      const sessionId = await acpStore.spawnSession(cwd);
      console.log("[AgentChat] Session started:", sessionId);
    } catch (error) {
      console.error("[AgentChat] Failed to start session:", error);
    }
  };

  const sendMessage = async () => {
    const trimmed = input().trim();
    if (!trimmed || !hasSession() || !isReady()) return;

    setInput("");
    await acpStore.sendPrompt(trimmed);
  };

  const handleCancel = async () => {
    await acpStore.cancelPrompt();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const renderMessage = (message: AgentMessage) => {
    switch (message.type) {
      case "user":
        return (
          <article class="px-5 py-4 bg-[#161b22] border-b border-[#21262d]">
            <div class="text-sm leading-relaxed text-[#e6edf3] whitespace-pre-wrap">
              {message.content}
            </div>
          </article>
        );

      case "assistant":
        return (
          <article class="px-5 py-4 border-b border-[#21262d]">
            <div class="text-sm leading-relaxed text-[#e6edf3] whitespace-pre-wrap">
              {message.content}
            </div>
          </article>
        );

      case "thought":
        return (
          <article class="px-5 py-3 border-b border-[#21262d]">
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
          <article class="px-5 py-3 border-b border-[#21262d]">
            <div class="px-3 py-2 bg-[rgba(248,81,73,0.1)] border border-[rgba(248,81,73,0.4)] rounded-md text-sm text-[#f85149]">
              {message.content}
            </div>
          </article>
        );

      default:
        return null;
    }
  };

  return (
    <div class="flex-1 flex flex-col min-h-0">
      {/* Agent Tab Bar */}
      <Show when={hasSession()}>
        <AgentTabBar onNewSession={startSession} />
      </Show>

      {/* Plan Header */}
      <PlanHeader />

      {/* Messages Area */}
      <div
        ref={messagesRef}
        class="flex-1 min-h-0 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[#30363d] [&::-webkit-scrollbar-thumb]:rounded"
      >
        <Show
          when={hasSession()}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center p-10 text-[#8b949e]">
              <div class="max-w-[320px] text-center">
                <svg
                  class="w-12 h-12 mx-auto mb-4 text-[#30363d]"
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
                <h3 class="m-0 mb-2 text-base font-medium text-[#e6edf3]">
                  Start an Agent Session
                </h3>
                <p class="m-0 mb-4 text-sm">
                  Spawn an AI coding agent to help with complex tasks like
                  refactoring, debugging, or implementing features.
                </p>
                <div class="flex flex-col items-center gap-3 w-full max-w-md">
                  <AgentSelector />
                  <Show when={acpStore.selectedAgentType === "claude-code"}>
                    <div class="w-full px-3 py-2 bg-[#1f6feb]/10 border border-[#1f6feb]/30 rounded-md text-xs text-[#58a6ff]">
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
                          Claude Code CLI is installed on your computer.
                        </span>
                      </div>
                    </div>
                  </Show>
                  <button
                    type="button"
                    class="px-4 py-2 bg-[#238636] text-white rounded-md text-sm font-medium hover:bg-[#2ea043] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={startSession}
                    disabled={acpStore.isLoading}
                  >
                    {acpStore.isLoading
                      ? (acpStore.installStatus ?? "Starting...")
                      : "Start Agent"}
                  </button>
                </div>
              </div>
            </div>
          }
        >
          {/* Session Messages */}
          <Show
            when={acpStore.messages.length > 0 || acpStore.streamingContent}
            fallback={
              <div class="flex flex-col items-center justify-center p-10 text-[#8b949e]">
                <h3 class="m-0 mb-2 text-base font-medium text-[#e6edf3]">
                  Agent Ready
                </h3>
                <p class="m-0 text-sm text-center max-w-[280px]">
                  Describe what you'd like the agent to do. It can read files,
                  make edits, run commands, and more.
                </p>
              </div>
            }
          >
            <For each={acpStore.messages}>{renderMessage}</For>

            {/* Loading placeholder while waiting for first chunk */}
            <Show
              when={
                isPrompting() &&
                !acpStore.streamingContent &&
                !acpStore.streamingThinking
              }
            >
              <article class="px-5 py-4 border-b border-[#21262d]">
                <div class="flex items-center gap-2 text-sm text-[#8b949e]">
                  <span class="inline-block w-2 h-2 rounded-full bg-[#58a6ff] animate-pulse" />
                  <span>Waiting for agent response…</span>
                </div>
              </article>
            </Show>

            {/* Streaming Thinking */}
            <Show when={acpStore.streamingThinking}>
              <article class="px-5 py-3 border-b border-[#21262d]">
                <ThinkingBlock
                  thinking={acpStore.streamingThinking}
                  isStreaming={true}
                />
              </article>
            </Show>

            {/* Streaming Content */}
            <Show when={acpStore.streamingContent}>
              <article class="px-5 py-4 border-b border-[#21262d]">
                <div class="text-sm leading-relaxed text-[#e6edf3] whitespace-pre-wrap">
                  {acpStore.streamingContent}
                  <span class="inline-block w-2 h-4 ml-0.5 bg-[#58a6ff] animate-pulse" />
                </div>
              </article>
            </Show>
          </Show>
        </Show>
      </div>

      {/* Error Display */}
      <Show when={sessionError()}>
        <div class="mx-4 mb-2 px-3 py-2 bg-[rgba(248,81,73,0.1)] border border-[rgba(248,81,73,0.4)] rounded-md text-sm text-[#f85149] flex items-center justify-between">
          <span>{sessionError()}</span>
          <button
            type="button"
            class="text-xs underline hover:no-underline"
            onClick={() => acpStore.clearError()}
          >
            Dismiss
          </button>
        </div>
      </Show>

      {/* Input Area */}
      <Show when={hasSession()}>
        <div class="shrink-0 p-4 border-t border-[#21262d] bg-[#161b22]">
          <form
            class="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
          >
            <textarea
              ref={inputRef}
              value={input()}
              placeholder="Tell the agent what to do..."
              class="w-full min-h-[80px] max-h-[50vh] resize-y bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] p-3 font-inherit text-sm leading-normal transition-colors focus:outline-none focus:border-[#58a6ff] placeholder:text-[#484f58] disabled:opacity-60 disabled:cursor-not-allowed"
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              disabled={!isReady()}
            />
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-3">
                <AgentSelector />
                <Show when={isPrompting()}>
                  <span class="text-xs text-[#8b949e]">
                    Agent is working...
                  </span>
                </Show>
              </div>
              <div class="flex gap-2">
                <Show when={isPrompting()}>
                  <button
                    type="button"
                    class="px-4 py-1.5 bg-[#21262d] text-[#f85149] border border-[#30363d] rounded-md text-[13px] font-medium hover:bg-[#30363d] transition-colors"
                    onClick={handleCancel}
                  >
                    Cancel
                  </button>
                </Show>
                <button
                  type="submit"
                  class="px-4 py-1.5 bg-[#238636] text-white rounded-md text-[13px] font-medium hover:bg-[#2ea043] transition-colors disabled:bg-[#21262d] disabled:text-[#484f58] disabled:cursor-not-allowed"
                  disabled={!isReady() || !input().trim()}
                >
                  Send
                </button>
              </div>
            </div>
          </form>
        </div>
      </Show>
    </div>
  );
};
