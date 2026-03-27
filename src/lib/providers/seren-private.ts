// ABOUTME: Seren private models provider adapter for chat completions.
// ABOUTME: Routes requests through the seren-private-models publisher.

import { postChatCompletions } from "@/api/seren-private-models";
import { privateModelsService } from "@/services/private-models";
import type {
  AuthOptions,
  ChatRequest,
  ProviderAdapter,
  ProviderModel,
} from "./types";

async function send(request: ChatRequest): Promise<string> {
  const { data, error } = await postChatCompletions({
    body: {
      model: request.model,
      messages: request.messages as Array<Record<string, unknown>>,
      stream: false,
      tools: request.tools as Array<Record<string, unknown>> | undefined,
    },
    throwOnError: false,
  });

  if (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Private chat request failed";
    throw new Error(message);
  }

  const body = data as
    | { choices?: Array<{ message?: { content?: unknown } }> }
    | undefined;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

export const serenPrivateProvider: ProviderAdapter = {
  id: "seren-private",

  async sendMessage(
    request: ChatRequest,
    _auth: string | AuthOptions,
  ): Promise<string> {
    return send(request);
  },

  async *streamMessage(
    request: ChatRequest,
    _auth: string | AuthOptions,
  ): AsyncGenerator<string, void, unknown> {
    const content = await send(request);
    if (content) {
      yield content;
    }
  },

  async validateKey(_apiKey: string): Promise<boolean> {
    return true;
  },

  async getModels(_apiKey: string): Promise<ProviderModel[]> {
    return privateModelsService.listAvailable();
  },
};
