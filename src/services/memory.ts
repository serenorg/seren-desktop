// ABOUTME: Memory service for storing and retrieving conversation memories.
// ABOUTME: Wraps Tauri memory commands with authentication and project context.

import { invoke } from "@tauri-apps/api/core";
import { authStore } from "@/stores/auth.store";
import { projectStore } from "@/stores/project.store";
import { settingsStore } from "@/stores/settings.store";

export interface RecallResult {
  content: string;
  memory_type: string;
  relevance_score: number;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

/**
 * Check if memory feature is enabled and user is authenticated.
 */
function isMemoryAvailable(): boolean {
  return settingsStore.get("memoryEnabled") && authStore.isAuthenticated;
}

/**
 * Get the current project ID for memory operations.
 */
function getProjectId(): string | null {
  return projectStore.activeProject?.id ?? null;
}

/**
 * Store a memory to the cloud (and local cache).
 * Automatically includes project context if available.
 */
export async function rememberMemory(
  content: string,
  memoryType: string = "semantic",
): Promise<string> {
  if (!isMemoryAvailable()) {
    throw new Error("Memory feature not available - enable it in settings");
  }

  const projectId = getProjectId();

  return invoke<string>("memory_remember", {
    content,
    memoryType,
    projectId,
  });
}

/**
 * Search for memories matching a query.
 * Falls back to local cache if cloud is unavailable.
 */
export async function recallMemories(
  query: string,
  limit = 5,
): Promise<RecallResult[]> {
  if (!isMemoryAvailable()) {
    return [];
  }

  const projectId = getProjectId();

  try {
    return await invoke<RecallResult[]>("memory_recall", {
      query,
      projectId,
      limit,
    });
  } catch (error) {
    console.warn("[Memory] Failed to recall memories:", error);
    return [];
  }
}

/**
 * Sync local memory cache with cloud.
 * Pushes pending memories and pulls new ones.
 */
export async function syncMemories(): Promise<SyncResult | null> {
  if (!isMemoryAvailable()) {
    return null;
  }

  const userId = authStore.user?.id ?? null;
  const projectId = getProjectId();

  try {
    return await invoke<SyncResult>("memory_sync", {
      userId,
      projectId,
    });
  } catch (error) {
    console.warn("[Memory] Failed to sync memories:", error);
    return null;
  }
}

/**
 * Bootstrap memory context for system prompt injection.
 * This is called automatically in chat.ts.
 */
export async function bootstrapMemoryContext(): Promise<string | null> {
  if (!isMemoryAvailable()) {
    return null;
  }

  const projectId = getProjectId();

  try {
    return await invoke<string | null>("memory_bootstrap", {
      projectId,
    });
  } catch (error) {
    console.warn("[Memory] Failed to bootstrap memory context:", error);
    return null;
  }
}

/**
 * Store a conversation turn (user message + assistant response).
 * This should be called after each completed assistant response.
 */
export async function storeConversationTurn(
  userMessage: string,
  assistantMessage: string,
  context?: { model?: string; timestamp?: number },
): Promise<void> {
  if (!isMemoryAvailable()) {
    return;
  }

  const combinedContent = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;
  const metadata = context ? `\n\nModel: ${context.model || "unknown"}` : "";

  try {
    await rememberMemory(`${combinedContent}${metadata}`, "semantic");
  } catch (error) {
    console.error("[Memory] Failed to store conversation turn:", error);
  }
}

/**
 * Convenience function to store just an assistant response.
 */
export async function storeAssistantResponse(
  response: string,
  context?: { model?: string; userQuery?: string },
): Promise<void> {
  if (!isMemoryAvailable()) {
    return;
  }

  if (!response.trim()) {
    return;
  }

  const content = context?.userQuery
    ? `User: ${context.userQuery}\n\nAssistant: ${response}`
    : `Assistant: ${response}`;

  const metadata = context?.model ? `\n\nModel: ${context.model}` : "";

  try {
    await rememberMemory(`${content}${metadata}`, "semantic");
  } catch (error) {
    console.error("[Memory] Failed to store assistant response:", error);
  }
}
