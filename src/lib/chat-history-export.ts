// ABOUTME: Renders a conversation as plain-text markdown for copy/save exports.
// ABOUTME: Filters out tool calls, tool results, and other non-chat message types.

export interface ChatHistoryExportMessage {
  type: string;
  content: string;
}

const ACTIVE_SKILLS_HEADER = "# Active Skills";
const PUBLISHER_PRIMER_MARKERS = ["list_agent_publishers", "call_publisher"];
const SKILL_MANIFEST_MARKERS = [
  "Skill runtime directory",
  "Before using this skill, open",
  "/SKILL.md",
];

export function isGeneratedPromptPrimer(content: string): boolean {
  const trimmed = content.trimStart();
  const hasActiveSkillsHeader = trimmed.includes(ACTIVE_SKILLS_HEADER);
  if (!hasActiveSkillsHeader) return false;

  const hasPublisherPrimer = PUBLISHER_PRIMER_MARKERS.every((marker) =>
    trimmed.includes(marker),
  );
  const hasSkillManifest = SKILL_MANIFEST_MARKERS.some((marker) =>
    trimmed.includes(marker),
  );

  return hasPublisherPrimer || hasSkillManifest;
}

function exportableMessageContent(
  message: ChatHistoryExportMessage,
): string | null {
  if (isGeneratedPromptPrimer(message.content)) return null;
  return message.content;
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
    const content = exportableMessageContent(msg);
    if (content === null) continue;

    if (msg.type === "user") {
      markdown += `**You:** ${content}\n\n`;
    } else if (msg.type === "assistant") {
      markdown += `**Assistant:** ${content}\n\n`;
    }
  }
  return markdown;
}

/** Returns true if the conversation has at least one user or assistant message. */
export function hasExportableMessages(
  messages: readonly ChatHistoryExportMessage[],
): boolean {
  return messages.some(
    (m) =>
      (m.type === "user" || m.type === "assistant") &&
      exportableMessageContent(m) !== null,
  );
}
