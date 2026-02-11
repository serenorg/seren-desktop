// ABOUTME: Tab bar for managing multiple chat conversations.
// ABOUTME: Displays tabs with close buttons, permission indicators, and a new chat button.

import { type Component, For, Show } from "solid-js";
import {
  type Conversation,
  conversationStore,
} from "@/stores/conversation.store";
import { hasPendingApprovals } from "@/stores/mcp-chat.store";

export const ChatTabBar: Component = () => {
  const handleNewChat = async () => {
    // Prevent creating new chat during streaming to avoid confusion
    if (conversationStore.isLoading) {
      console.log("[ChatTabBar] Blocked new chat creation during streaming");
      return;
    }
    await conversationStore.createConversation();
  };

  const handleTabClick = (id: string) => {
    // Prevent tab switching during streaming to avoid chat history "loss"
    // The history isn't actually lost - it's just showing a different conversation
    if (
      conversationStore.isLoading &&
      id !== conversationStore.activeConversationId
    ) {
      console.log("[ChatTabBar] Blocked tab switch during streaming");
      return;
    }
    conversationStore.setActiveConversation(id);
  };

  const handleCloseTab = async (e: MouseEvent, id: string) => {
    e.stopPropagation(); // Prevent tab switch
    await conversationStore.archiveConversation(id);
  };

  // Filter out archived conversations
  const visibleConversations = () =>
    conversationStore.conversations.filter((c) => !c.isArchived);

  // Visual indicator for blocked state
  const isTabSwitchBlocked = () =>
    conversationStore.isLoading && visibleConversations().length > 1;

  return (
    <div class="flex items-center gap-1 px-3 py-2 bg-[#161b22] border-b border-[#21262d] min-h-[40px]">
      <div class="flex items-center gap-1 flex-1 overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden">
        <For each={visibleConversations()}>
          {(conversation: Conversation) => (
            <button
              type="button"
              class={`group flex items-center gap-1.5 px-2.5 py-1.5 bg-transparent border border-transparent rounded-md text-[13px] text-[#8b949e] whitespace-nowrap max-w-[180px] transition-all ${
                isTabSwitchBlocked() &&
                conversation.id !== conversationStore.activeConversationId
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer hover:bg-[rgba(139,148,158,0.1)] hover:text-[#e6edf3]"
              } ${conversation.id === conversationStore.activeConversationId ? "bg-[rgba(88,166,255,0.1)] border-[rgba(88,166,255,0.3)] text-[#58a6ff]" : ""}`}
              onClick={() => handleTabClick(conversation.id)}
              title={
                isTabSwitchBlocked() &&
                conversation.id !== conversationStore.activeConversationId
                  ? "Cannot switch tabs while processing"
                  : conversation.title
              }
            >
              <Show
                when={
                  conversation.id === conversationStore.activeConversationId &&
                  hasPendingApprovals()
                }
              >
                <span
                  class="permission-indicator"
                  title="Permission required"
                />
              </Show>
              <span class="overflow-hidden text-ellipsis max-w-[140px]">
                {conversation.title}
              </span>
              <Show when={visibleConversations().length > 1}>
                <button
                  type="button"
                  class="flex items-center justify-center w-4 h-4 p-0 bg-transparent border-none rounded-sm text-sm leading-none text-[#8b949e] cursor-pointer opacity-0 transition-all group-hover:opacity-100 hover:bg-[rgba(248,81,73,0.2)] hover:text-[#f85149]"
                  onClick={(e) => handleCloseTab(e, conversation.id)}
                  title="Close tab"
                >
                  ×
                </button>
              </Show>
            </button>
          )}
        </For>
      </div>
      <button
        type="button"
        class={`flex items-center justify-center w-7 h-7 p-0 bg-transparent border border-[#30363d] rounded-md text-lg leading-none text-[#8b949e] shrink-0 transition-all ${
          conversationStore.isLoading
            ? "cursor-not-allowed opacity-50"
            : "cursor-pointer hover:bg-[#21262d] hover:border-[#484f58] hover:text-[#e6edf3]"
        }`}
        onClick={handleNewChat}
        title={
          conversationStore.isLoading
            ? "Cannot create new chat while processing"
            : "New Chat"
        }
      >
        +
      </button>
    </div>
  );
};

export default ChatTabBar;
