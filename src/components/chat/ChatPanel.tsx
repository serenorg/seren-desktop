// ABOUTME: Chat panel component for AI conversation.
// ABOUTME: Displays message history and input for sending messages.

import { Component, createSignal, For } from "solid-js";
import { sendMessage, ChatMessage } from "@/services/chat";
import "./ChatPanel.css";

export const ChatPanel: Component = () => {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [input, setInput] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal("");

  const handleSend = async () => {
    const text = input().trim();
    if (!text || isLoading()) return;

    setError("");
    const userMessage: ChatMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await sendMessage([...messages(), userMessage]);
      setMessages((prev) => [...prev, response]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div class="chat-panel">
      <div class="chat-messages">
        <For each={messages()}>
          {(message) => (
            <div class={`chat-message chat-message-${message.role}`}>
              <div class="chat-message-role">
                {message.role === "user" ? "You" : "Assistant"}
              </div>
              <div class="chat-message-content">{message.content}</div>
            </div>
          )}
        </For>
        {isLoading() && (
          <div class="chat-message chat-message-assistant">
            <div class="chat-message-role">Assistant</div>
            <div class="chat-message-content chat-typing">Thinking...</div>
          </div>
        )}
        {error() && <div class="chat-error">{error()}</div>}
      </div>
      <div class="chat-input-container">
        <textarea
          class="chat-input"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send)"
          disabled={isLoading()}
          rows={3}
        />
        <button
          class="chat-send"
          onClick={handleSend}
          disabled={isLoading() || !input().trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
};
