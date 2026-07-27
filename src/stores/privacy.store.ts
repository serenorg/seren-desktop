// ABOUTME: Conversation-level privacy controls for local memory and history sync.
// ABOUTME: Persists exclusion choices through the same Tauri/browser settings boundary as app settings.

import { createStore } from "solid-js/store";
import { isTauriRuntime, setConversationPrivileged } from "@/lib/tauri-bridge";

const PRIVACY_STORE = "privacy.json";
const CONVERSATIONS_KEY = "conversations";
const BROWSER_PRIVACY_KEY = "seren_conversation_privacy";

export interface ConversationPrivacy {
  excludeMemory: boolean;
  excludeHistorySync: boolean;
  /** Privileged conversations deny memory, history sync, notes export, and unsafe providers. */
  privileged: boolean;
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
      privileged: candidate.privileged === true,
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
      privileged: false,
    }
  );
}

// Conversations whose data has been deleted this session. A turn's memory
// capture is fired fire-and-forget at turn end and can still be in flight when
// the user deletes the conversation; checking this at the capture's write point
// stops a late capture from re-creating a retained cloud source the delete just
// erased (#3348). Bounded so it cannot grow without limit.
const ERASED_CONVERSATION_LIMIT = 512;
const erasedConversationIds = new Set<string>();

export const privacyStore = {
  getConversationPrivacy(id: string): ConversationPrivacy {
    return flagsFor(id);
  },

  isMemoryExcluded(id: string | null | undefined): boolean {
    return id ? flagsFor(id).privileged || flagsFor(id).excludeMemory : false;
  },

  /** Record that a conversation was deleted so an in-flight memory capture for
   * it does not re-create a retained source after the erase (#3348). */
  markConversationErased(id: string): void {
    if (erasedConversationIds.size >= ERASED_CONVERSATION_LIMIT) {
      erasedConversationIds.clear();
    }
    erasedConversationIds.add(id);
  },

  isConversationErased(id: string | null | undefined): boolean {
    return id ? erasedConversationIds.has(id) : false;
  },

  isHistorySyncExcluded(id: string | null | undefined): boolean {
    return id
      ? flagsFor(id).privileged || flagsFor(id).excludeHistorySync
      : false;
  },

  isPrivileged(id: string | null | undefined): boolean {
    return id ? flagsFor(id).privileged : false;
  },

  /**
   * Merge the durable SQLite flag into renderer state without writing it back.
   * A stale or unavailable privacy.json must never make a persisted privileged
   * conversation eligible for egress after an app restart.
   */
  hydrateConversationPrivilege(id: string, privileged: boolean): void {
    if (!id || !privileged) return;
    const current = flagsFor(id);
    setPrivacyState("conversations", id, {
      ...current,
      privileged: true,
    });
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
    if ("privileged" in updates) {
      void setConversationPrivileged(id, next.privileged).catch((error) => {
        console.warn(
          "[Privacy] Failed to persist Privacy Mode to the chat DB:",
          error,
        );
      });
    }
  },

  excludedHistorySyncIds(): string[] {
    return Object.entries(privacyState.conversations)
      .filter(([, flags]) => flags.privileged || flags.excludeHistorySync)
      .map(([id]) => id);
  },

  /**
   * Drop every per-conversation privacy entry and persist the empty state, for
   * the "erase all data" flow. privacy.json maps conversation IDs to their
   * privacy flags, so it must not survive an erase-all (#3348).
   */
  async clearAll(): Promise<void> {
    erasedConversationIds.clear();
    setPrivacyState("conversations", {});
    await saveStoredPrivacy();
  },
};

export { privacyState };
