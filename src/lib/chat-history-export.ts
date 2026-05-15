// ABOUTME: Renders a conversation as plain-text markdown for copy/save exports.
// ABOUTME: Filters out tool calls, tool results, and other non-chat message types.

import type { UnifiedMessage } from "@/types/conversation";

export interface ChatHistoryExportMessage {
  type: UnifiedMessage["type"];
  content: string;
}

/**
 * Format a chat conversation as markdown.
 *
 * Only `user` and `assistant` message types are included. Tool calls, tool
 * results, diffs, thoughts, transitions, reroutes, and error messages are
 * filtered out so that exports contain only the human-readable chat.
 *
 * `role`-based filtering is unsafe here: tool calls and tool results are
 * persisted with `role: "assistant"` but carry the tool name or raw JSON
 * payload as content. Filtering must use the `type` discriminator.
 */
export function formatChatHistoryMarkdown(
  messages: readonly ChatHistoryExportMessage[],
  options: { header?: string; exportedAt?: Date } = {},
): string {
  const header = options.header ?? "# Chat History";
  let markdown = `${header}\n\n`;
  if (options.exportedAt) {
    markdown += `*Exported ${options.exportedAt.toLocaleString()}*\n\n---\n\n`;
  }
  for (const msg of messages) {
    if (msg.type === "user") {
      markdown += `**You:** ${msg.content}\n\n`;
    } else if (msg.type === "assistant") {
      markdown += `**Assistant:** ${msg.content}\n\n`;
    }
  }
  return markdown;
}

/** Returns true if the conversation has at least one user or assistant message. */
export function hasExportableMessages(
  messages: readonly ChatHistoryExportMessage[],
): boolean {
  return messages.some((m) => m.type === "user" || m.type === "assistant");
}
