// ABOUTME: Detects transitions in producer provider/model across consecutive
// ABOUTME: assistant messages so the transcript can render a boundary marker.

import { PROVIDER_CONFIGS, type ProviderId } from "@/lib/providers/types";
import type { UnifiedMessage } from "@/types/conversation";

/**
 * Compact label for a producer provider — either a chat provider id from
 * `PROVIDER_CONFIGS` or an external agent type (`claude-code` / `codex` /
 * `gemini`). Falls back to a humanized version of the raw id so a future
 * provider added to `messages.provider` shows up as something readable
 * rather than the empty string.
 */
export function providerDisplayName(
  provider: string | null | undefined,
): string {
  if (!provider) return "Unknown";
  if (provider in PROVIDER_CONFIGS) {
    return PROVIDER_CONFIGS[provider as ProviderId].name;
  }
  switch (provider) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    default: {
      // Title-case the raw id so unknown providers still render legibly.
      // Drop empty segments so a leading, trailing, or repeated separator
      // does not introduce extra whitespace in the label.
      const titled = provider
        .split(/[-_]/)
        .filter((part) => part.length > 0)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join(" ");
      return titled.length > 0 ? titled : "Unknown";
    }
  }
}

export interface ProviderBoundary {
  fromProvider: string | null;
  fromModel: string | null;
  toProvider: string | null;
  toModel: string | null;
}

/**
 * Walk the message list and identify producer transitions across
 * consecutive assistant messages. Returns a map keyed by the id of the
 * message that *follows* a boundary. The first assistant message in a
 * thread never produces a boundary because there is no prior producer
 * to compare against — by definition the thread "started" with whatever
 * provider produced that message.
 *
 * Boundaries fire on either provider OR model change. User messages,
 * tool calls, tool results, system rerouting, and other non-assistant
 * rows are passed through transparently — they do not break the
 * "previous producer" chain because they do not have a producer.
 */
export function computeProviderBoundaries(
  messages: UnifiedMessage[],
): Map<string, ProviderBoundary> {
  const boundaries = new Map<string, ProviderBoundary>();
  let lastProvider: string | null | undefined;
  let lastModel: string | null | undefined;
  let seenAnyAssistant = false;

  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    const provider = msg.provider ?? null;
    const model = msg.modelId ?? null;

    if (seenAnyAssistant) {
      const providerChanged = (lastProvider ?? null) !== provider;
      const modelChanged = (lastModel ?? null) !== model;
      if (providerChanged || modelChanged) {
        boundaries.set(msg.id, {
          fromProvider: lastProvider ?? null,
          fromModel: lastModel ?? null,
          toProvider: provider,
          toModel: model,
        });
      }
    }

    seenAnyAssistant = true;
    lastProvider = provider;
    lastModel = model;
  }

  return boundaries;
}
