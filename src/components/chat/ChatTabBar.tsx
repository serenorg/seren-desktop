// ABOUTME: Tab bar for managing multiple chat conversations.
// ABOUTME: Displays tabs with close buttons and a new chat button.

import { type Component, For, Show } from "solid-js";
import { chatStore, type Conversation } from "@/stores/chat.store";
import "./ChatTabBar.css";

export const ChatTabBar: Component = () => {
  const handleNewChat = async () => {
    await chatStore.createConversation();
  };

  const handleTabClick = (id: string) => {
    chatStore.setActiveConversation(id);
  };

  const handleCloseTab = async (e: MouseEvent, id: string) => {
    e.stopPropagation(); // Prevent tab switch
    await chatStore.archiveConversation(id);
  };

  // Filter out archived conversations
  const visibleConversations = () =>
    chatStore.conversations.filter((c) => !c.isArchived);

  return (
    <div class="chat-tab-bar">
      <div class="chat-tabs">
        <For each={visibleConversations()}>
          {(conversation: Conversation) => (
            <button
              type="button"
              class={`chat-tab ${conversation.id === chatStore.activeConversationId ? "active" : ""}`}
              onClick={() => handleTabClick(conversation.id)}
              title={conversation.title}
            >
              <span class="tab-title">{conversation.title}</span>
              <Show when={visibleConversations().length > 1}>
                <button
                  type="button"
                  class="tab-close"
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
        class="new-chat-btn"
        onClick={handleNewChat}
        title="New Chat"
      >
        +
      </button>
    </div>
  );
};

export default ChatTabBar;
