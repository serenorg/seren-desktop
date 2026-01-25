import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { Message } from "@/services/chat";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";
const MAX_MESSAGES = 50;

type MessagePatch = Partial<Omit<Message, "id" | "timestamp" | "role" | "model" | "content">> &
  Partial<Pick<Message, "content" | "model" | "timestamp" | "role" | "error" | "status" | "attemptCount">>;

interface ChatState {
  messages: Message[];
  selectedModel: string;
  isLoading: boolean;
  error: string | null;
  retryingMessageId: string | null;
}

const [state, setState] = createStore<ChatState>({
  messages: [],
  selectedModel: DEFAULT_MODEL,
  isLoading: false,
  error: null,
  retryingMessageId: null,
});

export const chatStore = {
  get messages() {
    return state.messages;
  },
  get selectedModel() {
    return state.selectedModel;
  },
  get isLoading() {
    return state.isLoading;
  },
  get error() {
    return state.error;
  },
  get retryingMessageId() {
    return state.retryingMessageId;
  },

  addMessage(message: Message) {
    setState("messages", (existing) => {
      const next = [...existing, message];
      if (next.length > MAX_MESSAGES) {
        return next.slice(-MAX_MESSAGES);
      }
      return next;
    });
  },

  updateMessage(id: string, patch: MessagePatch) {
    setState("messages", (msgs) =>
      msgs.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg))
    );
  },

  setMessages(messages: Message[]) {
    setState("messages", messages.slice(-MAX_MESSAGES));
  },

  setModel(modelId: string) {
    setState("selectedModel", modelId);
  },

  setLoading(isLoading: boolean) {
    setState("isLoading", isLoading);
  },

  setError(error: string | null) {
    setState("error", error);
  },

  setRetrying(id: string | null) {
    setState("retryingMessageId", id);
  },

  clearMessages() {
    setState("messages", []);
  },

  async persistMessage(message: Message) {
    try {
      await invoke("save_message", {
        id: message.id,
        role: message.role,
        content: message.content,
        model: message.model ?? null,
        timestamp: message.timestamp,
      });
    } catch (error) {
      console.warn("Unable to persist message", error);
    }
  },

  async loadHistory(limit = MAX_MESSAGES) {
    try {
      const messages = (await invoke("get_messages", { limit })) as Message[];
      this.setMessages(messages);
    } catch (error) {
      console.warn("Unable to load history", error);
    }
  },

  async clearHistory() {
    try {
      await invoke("clear_history");
    } catch (error) {
      console.warn("Unable to clear history", error);
    }
    this.clearMessages();
  },
};

export type { Message };
export const MAX_CHAT_MESSAGES = MAX_MESSAGES;
