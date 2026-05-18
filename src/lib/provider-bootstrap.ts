// ABOUTME: Deterministic bootstrap context builder for cross-provider thread switches.
// ABOUTME: Truncates the canonical transcript without invoking a model.

/**
 * Providers that own a native session and need a bootstrap message to
 * understand prior turns on a thread they have never seen. Chat-side
 * providers can read the canonical transcript directly through normal
 * orchestration and do not need a bootstrap.
 */
const NATIVE_AGENT_PROVIDERS = new Set(["claude-code", "codex", "gemini"]);

export function providerNeedsBootstrap(provider: string): boolean {
  return NATIVE_AGENT_PROVIDERS.has(provider);
}

export interface BootstrapMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const DEFAULT_PER_MESSAGE_CHARS = 500;
const DEFAULT_MAX_MESSAGES = 30;
const DEFAULT_OVERALL_BUDGET = 12_000;

/**
 * Build a deterministic transcript recap for a fresh native agent
 * session. The format is intentionally simple — no model summarization
 * — so the same input always produces the same output and an operator
 * can read it back. Per-message truncation keeps a single long message
 * from monopolizing the budget; overall budget caps total size.
 */
export function buildProviderBootstrapContext(
  messages: BootstrapMessage[],
  options: {
    perMessageChars?: number;
    maxMessages?: number;
    overallBudget?: number;
  } = {},
): string {
  const perMessage = options.perMessageChars ?? DEFAULT_PER_MESSAGE_CHARS;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const overallBudget = options.overallBudget ?? DEFAULT_OVERALL_BUDGET;

  // Keep the tail of the conversation (most recent N messages) — the
  // new provider needs the most relevant context first, not history
  // from minutes earlier.
  const tail = messages.slice(-maxMessages);

  const lines: string[] = [
    "You are continuing an existing Seren thread after a provider switch.",
    "The following transcript is the canonical prior context. Continue from",
    "the user's next message and do not mention this bootstrap unless necessary.",
    "",
    "<transcript>",
  ];

  let used = lines.join("\n").length;
  for (const msg of tail) {
    const role = msg.role.toUpperCase();
    const trimmed =
      msg.content.length > perMessage
        ? `${msg.content.slice(0, perMessage)}…`
        : msg.content;
    const entry = `[${role}]: ${trimmed}`;
    if (used + entry.length + 1 > overallBudget) break;
    lines.push(entry);
    used += entry.length + 1;
  }

  lines.push("</transcript>");
  return lines.join("\n");
}
