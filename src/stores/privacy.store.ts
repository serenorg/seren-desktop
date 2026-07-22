// ABOUTME: Conversation-level privacy controls for local memory and history sync.
// ABOUTME: Persists exclusion choices through the same Tauri/browser settings boundary as app settings.

import { createStore } from "solid-js/store";
import { isTauriRuntime } from "@/lib/tauri-bridge";

const PRIVACY_STORE = "privacy.json";
const CONVERSATIONS_KEY = "conversations";
const BROWSER_PRIVACY_KEY = "seren_conversation_privacy";

export interface ConversationPrivacy {
  excludeMemory: boolean;
  excludeHistorySync: boolean;
}

interface PrivacyState {
  conversations: Record<string, ConversationPrivacy>;
  isLoading: boolean;
}

const [privacyState, setPrivacyState] = createStore<PrivacyState>({
  conversations: {},
  isLoading: true,
});

async function getInvoke(): Promise<
  typeof import("@tauri-apps/api/core").invoke | null
> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

function normalizeConversations(
  value: unknown,
): Record<string, ConversationPrivacy> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const normalized: Record<string, ConversationPrivacy> = {};
  for (const [id, flags] of Object.entries(value)) {
    if (!flags || typeof flags !== "object" || Array.isArray(flags)) continue;
    const candidate = flags as Partial<ConversationPrivacy>;
    normalized[id] = {
      excludeMemory: candidate.excludeMemory === true,
      excludeHistorySync: candidate.excludeHistorySync === true,
    };
  }
  return normalized;
}

async function loadStoredPrivacy(): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<string | null>("get_setting", {
      store: PRIVACY_STORE,
      key: CONVERSATIONS_KEY,
    });
  }
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(BROWSER_PRIVACY_KEY);
}

async function saveStoredPrivacy(): Promise<void> {
  const value = JSON.stringify(privacyState.conversations);
  try {
    const invoke = await getInvoke();
    if (invoke) {
      await invoke("set_setting", {
        store: PRIVACY_STORE,
        key: CONVERSATIONS_KEY,
        value,
      });
      return;
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(BROWSER_PRIVACY_KEY, value);
    }
  } catch (error) {
    console.warn("[Privacy] Failed to persist conversation controls:", error);
  }
}

export async function loadPrivacySettings(): Promise<void> {
  setPrivacyState("isLoading", true);
  try {
    const stored = await loadStoredPrivacy();
    if (stored) {
      setPrivacyState(
        "conversations",
        normalizeConversations(JSON.parse(stored)),
      );
    }
  } catch {
    setPrivacyState("conversations", {});
  } finally {
    setPrivacyState("isLoading", false);
  }
}

function flagsFor(id: string): ConversationPrivacy {
  return (
    privacyState.conversations[id] ?? {
      excludeMemory: false,
      excludeHistorySync: false,
    }
  );
}

export const privacyStore = {
  getConversationPrivacy(id: string): ConversationPrivacy {
    return flagsFor(id);
  },

  isMemoryExcluded(id: string | null | undefined): boolean {
    return id ? flagsFor(id).excludeMemory : false;
  },

  isHistorySyncExcluded(id: string | null | undefined): boolean {
    return id ? flagsFor(id).excludeHistorySync : false;
  },

  setConversationPrivacy(
    id: string,
    updates: Partial<ConversationPrivacy>,
  ): void {
    if (!id) return;
    const next = {
      ...flagsFor(id),
      ...updates,
    };
    setPrivacyState("conversations", id, next);
    void saveStoredPrivacy();
  },

  excludedHistorySyncIds(): string[] {
    return Object.entries(privacyState.conversations)
      .filter(([, flags]) => flags.excludeHistorySync)
      .map(([id]) => id);
  },
};

export { privacyState };
