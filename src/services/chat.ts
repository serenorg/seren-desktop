// ABOUTME: Chat service for sending messages to the AI.
// ABOUTME: Non-streaming implementation for Phase 1; streaming added in Phase 2.

import { API_BASE } from "@/lib/config";
import { getToken } from "@/lib/tauri-bridge";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  message: ChatMessage;
}

/**
 * Send a message to the chat API and get a response.
 * Uses the agent/api endpoint for AI completions.
 * This is a non-streaming implementation.
 */
export async function sendMessage(
  messages: ChatMessage[]
): Promise<ChatMessage> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${API_BASE}/agent/api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      message: "Chat request failed",
    }));
    throw new Error(error.message || "Chat request failed");
  }

  const data: ChatResponse = await response.json();
  return data.message;
}
