// ABOUTME: Deterministic bootstrap context builder for cross-provider thread switches.
// ABOUTME: Truncates the canonical transcript without invoking a model.

import type { AgentType } from "@/services/providers";

/**
 * Providers that own a native session and need a bootstrap message to
 * understand prior turns on a thread they have never seen. Chat-side
 * providers can read the canonical transcript directly through normal
 * orchestration and do not need a bootstrap. Sourced from the canonical
 * `AgentType` union in `@/services/providers` to avoid drift.
 */
const NATIVE_AGENT_PROVIDERS: ReadonlySet<AgentType> = new Set<AgentType>([
  "claude-code",
  "codex",
  "gemini",
  "grok",
  "lmstudio",
]);

export function providerNeedsBootstrap(provider: string): boolean {
  return (NATIVE_AGENT_PROVIDERS as ReadonlySet<string>).has(provider);
}

export interface BootstrapMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const DEFAULT_PER_MESSAGE_CHARS = 500;
const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_OVERALL_BUDGET_BYTES = 12_000;

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * Build a deterministic transcript recap for a fresh native agent
 * session. The format is intentionally simple - no model summarization
 * - so the same input always produces the same output and an operator
 * can read it back.
 *
 * Per-message truncation keeps a single long message from monopolizing
 * the budget. The overall budget is measured in UTF-8 bytes so multi-
 * byte content (emoji, CJK) cannot quietly blow past the cap; a
 * `string.length` (UTF-16 code units) check undercounts those by up to
 * 4x. The tail is iterated newest-first so when the budget runs out we
 * keep the most recent turns and elide the oldest, matching the agent
 * bootstrap contract: the next provider needs the most relevant context
 * first, not history from minutes earlier.
 */
export function buildProviderBootstrapContext(
  messages: BootstrapMessage[],
  options: {
    perMessageChars?: number;
    maxMessages?: number;
    overallBudgetBytes?: number;
  } = {},
): string {
  const perMessage = options.perMessageChars ?? DEFAULT_PER_MESSAGE_CHARS;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const overallBudgetBytes =
    options.overallBudgetBytes ?? DEFAULT_OVERALL_BUDGET_BYTES;

  const header = [
    "You are continuing an existing Seren thread after a provider switch.",
    "The following transcript is the canonical prior context. Continue from",
    "the user's next message and do not mention this bootstrap unless necessary.",
    "",
    "<transcript>",
  ];
  const footer = "</transcript>";

  let used = utf8ByteLength(header.join("\n")) + 1 + utf8ByteLength(footer);

  // Take the most-recent window first, then admit entries newest-first
  // so a tight byte budget drops the oldest of that window, not the
  // newest.
  const tail = messages.slice(-maxMessages);
  const admitted: string[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const msg = tail[i];
    const role = msg.role.toUpperCase();
    const trimmed =
      msg.content.length > perMessage
        ? `${msg.content.slice(0, perMessage)}…`
        : msg.content;
    const entry = `[${role}]: ${trimmed}`;
    const entryBytes = utf8ByteLength(entry) + 1;
    if (used + entryBytes > overallBudgetBytes) break;
    admitted.push(entry);
    used += entryBytes;
  }
  admitted.reverse();

  return [...header, ...admitted, footer].join("\n");
}
