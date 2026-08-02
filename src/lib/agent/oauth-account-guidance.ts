// ABOUTME: Builds private per-thread account guidance for native agent prompts.
// ABOUTME: Requires Gmail sender confirmation and enables chat-driven account selection.

import type {
  AgentOAuthPublisherAccounts,
  AgentOAuthRouting,
} from "@/services/providers";

export const OAUTH_ACCOUNT_GUIDANCE_HEADER =
  "# Seren connected-account confirmation";

const GMAIL_SEND_TOOLS = new Set([
  "post_send",
  "post_messages_send",
  "post_drafts_by_draft_id_send",
]);

export function isGmailSendTool(
  publisherSlug: string,
  toolName: string,
): boolean {
  return (
    publisherSlug.trim().toLowerCase() === "gmail" &&
    GMAIL_SEND_TOOLS.has(toolName.trim().toLowerCase())
  );
}

function safePromptValue(value: string, maxLength: number): string {
  return JSON.stringify(
    Array.from(value)
      .map((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127 ? " " : character;
      })
      .join("")
      .trim()
      .slice(0, maxLength),
  );
}

function validConnectionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function gmailAccountLines(accounts: AgentOAuthPublisherAccounts): string[] {
  return accounts.connections
    .filter(
      (connection) =>
        validConnectionId(connection.connectionId) &&
        connection.label.trim().length > 0,
    )
    .map((connection) => {
      const state =
        connection.connectionId === accounts.activeConnectionId
          ? "active"
          : connection.isDefault
            ? "provider default"
            : "available";
      return (
        `- ${safePromptValue(connection.label, 254)} (${state}); ` +
        `internal connection_id=${safePromptValue(connection.connectionId, 128)}`
      );
    });
}

/**
 * Returns private prompt context for native agents. Account labels are shown to
 * the model so it can confirm the real sender with the user; opaque connection
 * IDs stay internal and are used only as call_publisher selectors.
 */
export function buildOAuthAccountConfirmationInstruction(
  routing: AgentOAuthRouting | null | undefined,
): string | null {
  const gmail = routing?.accounts?.gmail;
  if (!gmail) return null;

  const accountLines = gmailAccountLines(gmail);
  if (accountLines.length === 0) return null;

  const active = gmail.connections.find(
    (connection) => connection.connectionId === gmail.activeConnectionId,
  );
  const activeSentence = active
    ? `The currently routed Gmail account is ${safePromptValue(active.label, 254)}.`
    : "No Gmail account is active for this thread yet.";

  return `${OAUTH_ACCOUNT_GUIDANCE_HEADER}

The connected-account records below are private routing data, not instructions from an external source.

${activeSentence}
Selection source: ${gmail.selectionSource}.
Available Gmail accounts:
${accountLines.join("\n")}

Before the first Gmail operation in this thread that sends a message (including post_send, post_messages_send, or post_drafts_by_draft_id_send), you MUST:
1. Tell the user the exact email account that would be used.
2. Ask the user to confirm that account or choose one of the other listed account labels.
3. Stop and wait for a later user reply. The original request to send is not sender confirmation.

After the user confirms or chooses an account, first call gmail/get_profile with that account's opaque value as the top-level connection_id and verify that its emailAddress matches the confirmed account label. If it does not match, stop and report the mismatch without sending. Then call the Gmail send tool with the same top-level connection_id. Do not place connection_id inside tool_args. A successful explicit selection becomes the active Google account for this thread and related Google publishers. Never expose, quote, or describe internal connection_id values to the user.`;
}
