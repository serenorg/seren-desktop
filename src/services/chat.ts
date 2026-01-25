// ABOUTME: Chat service supporting streaming completions, retries, and context injection.

import { apiBase } from "@/lib/config";
import { getToken } from "@/services/auth";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatContextRange {
  startLine: number;
  endLine: number;
}

export interface ChatContext {
  content: string;
  file?: string | null;
  range?: ChatContextRange | null;
}

export interface Message {
  id: string;
  role: ChatRole;
  content: string;
  model?: string;
  timestamp: number;
  status?: "pending" | "streaming" | "complete" | "error";
  error?: string | null;
  attemptCount?: number;
  request?: {
    prompt: string;
    context?: ChatContext;
  };
}

interface ChatCompletionPayload {
  model: string;
  messages: Array<{ role: ChatRole; content: string }>;
  stream?: boolean;
}

const CHAT_ENDPOINT = `${apiBase}/chat/completions`;
export const CHAT_MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;

export async function sendMessage(
  content: string,
  model: string,
  context?: ChatContext
): Promise<string> {
  const token = await requireToken();
  const payload = buildPayload(content, model, context, false);

  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Chat completion failed: ${response.status}`);
  }

  const data = await response.json();
  return extractContent(data);
}

export async function* streamMessage(
  content: string,
  model: string,
  context?: ChatContext
): AsyncGenerator<string> {
  const token = await requireToken();
  const payload = buildPayload(content, model, context, true);

  const response = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Streaming failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          return;
        }

        const delta = parseDelta(data);
        if (delta) {
          yield delta;
        }
      }
    }
  } catch (error) {
    throw new Error(
      `Streaming connection interrupted: ${(error as Error).message}`
    );
  } finally {
    reader.releaseLock();
  }
}

export async function sendMessageWithRetry(
  content: string,
  model: string,
  context: ChatContext | undefined,
  onRetry?: (attempt: number) => void
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CHAT_MAX_RETRIES; attempt++) {
    try {
      return await sendMessage(content, model, context);
    } catch (error) {
      lastError = error as Error;

      const message = lastError.message || "";
      if (message.includes("401") || message.includes("403")) {
        throw lastError;
      }

      if (attempt < CHAT_MAX_RETRIES) {
        const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
        onRetry?.(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error("Chat request failed");
}

function buildPayload(
  content: string,
  model: string,
  context: ChatContext | undefined,
  stream: boolean
): ChatCompletionPayload {
  const messages: Array<{ role: ChatRole; content: string }> = [];

  if (context && context.content.trim().length > 0) {
    const locationParts = [] as string[];
    if (context.file) {
      locationParts.push(context.file);
    }
    if (context.range) {
      locationParts.push(
        `lines ${context.range.startLine}-${context.range.endLine}`
      );
    }
    const location = locationParts.length
      ? ` from ${locationParts.join(" ")}`
      : "";

    messages.push({
      role: "system",
      content: `The user selected the following context${location}. Use it when responding.\n\n<context>\n${context.content}\n</context>`,
    });
  }

  messages.push({ role: "user", content });

  return { model, messages, stream };
}

function extractContent(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }

  const payload = data as Record<string, unknown>;
  const choices = payload.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const first = choices[0];
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") {
      return message.content;
    }

    const delta = first.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string") {
      return delta.content;
    }
  }

  if (typeof payload.content === "string") {
    return payload.content;
  }

  return JSON.stringify(data);
}

function parseDelta(data: string): string | null {
  try {
    const parsed = JSON.parse(data);

    if (parsed.delta && parsed.delta.content) {
      return normalizeContent(parsed.delta.content);
    }

    if (parsed.choices && parsed.choices[0]?.delta?.content) {
      return normalizeContent(parsed.choices[0].delta.content);
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeContent(chunk: unknown): string | null {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (Array.isArray(chunk)) {
    return chunk
      .map((piece) => {
        if (!piece) return "";
        if (typeof piece === "string") return piece;
        if (typeof piece === "object" && "text" in piece) {
          return (piece as Record<string, unknown>).text ?? "";
        }
        return "";
      })
      .join("");
  }

  if (typeof chunk === "object" && chunk && "text" in chunk) {
    return (chunk as Record<string, string>).text ?? null;
  }

  return null;
}

async function requireToken(): Promise<string> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  return token;
}
