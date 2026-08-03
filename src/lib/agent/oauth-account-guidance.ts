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

function extractGmailProfileEmailAtDepth(
  result: unknown,
  depth: number,
): string | null {
  if (depth > 4) return null;
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = item as { type?: unknown; text?: unknown };
      if (content.type !== "text" || typeof content.text !== "string") continue;
      const email = extractGmailProfileEmailAtDepth(content.text, depth + 1);
      if (email) return email;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = record.emailAddress;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }
  for (const envelope of ["data", "body", "result", "content"] as const) {
    if (!(envelope in record)) continue;
    const email = extractGmailProfileEmailAtDepth(record[envelope], depth + 1);
    if (email) return email;
  }
  return null;
}

export function extractGmailProfileEmail(result: unknown): string | null {
  return extractGmailProfileEmailAtDepth(result, 0);
}

export function gmailProfileMatchesConnection(
  routing: AgentOAuthRouting | null | undefined,
  connectionId: string,
  emailAddress: string,
): boolean {
  const expected = routing?.accounts?.gmail?.connections.find(
    (connection) => connection.connectionId === connectionId,
  )?.label;
  if (!expected?.includes("@")) return true;
  return expected.trim().toLowerCase() === emailAddress.trim().toLowerCase();
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
1. Call gmail/get_profile with the currently routed account's opaque value as the top-level connection_id and verify that its emailAddress matches the account label. If it does not match, stop and report the mismatch without sending.
2. Tell the user the exact verified email account that would be used and list the other account labels when available.
3. Ask the user to confirm that account or choose one of the other listed account labels.
4. Stop and wait for a later user reply. The original request to send is not sender confirmation.

After the user confirms the verified account, call the Gmail send tool with the same top-level connection_id. If the user chooses another account, first call gmail/get_profile with that account's top-level connection_id and verify its emailAddress, then send with that same selector. The host rejects a send on the same human turn that opened the confirmation checkpoint, even if you supply a connection_id. Do not place connection_id inside tool_args. A successful explicit selection becomes the active Google account for this thread and related Google publishers. Never expose, quote, or describe internal connection_id values to the user.`;
}
