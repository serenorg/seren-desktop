// ABOUTME: Chat/orchestrator request-envelope token accounting for compaction (#2115).
// ABOUTME: Counts request overhead beyond visible messages: system, tools, skills, summaries.

import {
  type AccountedMessage,
  estimateAccountedMessageTokens,
  estimateValueTokens,
} from "@/lib/compaction/token-accounting";
import { estimateTokens } from "@/lib/token-counter";

/**
 * Small synchronous shape for thread-effective skills. The Rust orchestrator
 * loads full SKILL.md content only after query classification, so the UI gauge
 * cannot know exact skill prompt bytes ahead of time. This metadata is the
 * exact frontend payload sent in `installed_skills`, and future cached
 * SKILL.md estimates can be added without changing chat-store call sites.
 */
export interface ChatSkillEstimate {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  path?: string;
}

export interface ChatRequestTokenEstimateInput {
  messages: AccountedMessage[];
  /** Static/system prompt content known synchronously by the UI. */
  systemPrompt?: string;
  /** Tool schemas/capabilities sent to the orchestrator. */
  toolSchemas?: unknown;
  /** Thread-effective skill metadata sent to the orchestrator. */
  skills?: ChatSkillEstimate[];
  /** Compacted summary injected as a system history message. */
  compactedSummary?: string | null;
  /** Conservative reserve for async memory/repo/semantic context. */
  dynamicContextReserveTokens?: number;
}

export interface ChatRequestTokenEstimate {
  totalTokens: number;
  messageTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  skillTokens: number;
  compactedSummaryTokens: number;
  dynamicContextReserveTokens: number;
}

/**
 * Stable approximation of the Rust ChatModelWorker's always-on system prompt:
 * current date, Seren-auth/tool rules, file-output rules, publisher routing,
 * and tone behavior. The exact prompt is assembled in Rust, but this captures
 * its persistent token load so the gauge no longer counts only transcript text.
 */
export const CHAT_ORCHESTRATOR_BASE_SYSTEM_PROMPT =
  "Current date (UTC): <date>. Use this date for dated artifacts unless the user supplies a different date.\n\n" +
  "You are a helpful AI assistant running inside Seren Desktop. The user is authenticated and tool calls are pre-authenticated through Seren Gateway. Never ask for API keys or environment variables; call tools directly.\n\n" +
  "File output rules: respect requested paths and filenames; expand ~/ as home; when asked for a PDF, use write_pdf_from_html directly with complete self-contained HTML.\n\n" +
  "Publisher-routing rules: prefer connected gateway publisher tools for Gmail, GitHub, Slack, Jira, and similar services over browser automation when a matching gateway publisher tool is available.\n\n" +
  "Tone and behavior: be concise; do not use empty praise; push back honestly; never deny tools before checking the actual tool list.";

function estimateMessages(messages: AccountedMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateAccountedMessageTokens(message);
  }
  return total;
}

function estimateSkills(skills: ChatSkillEstimate[] | undefined): number {
  if (!skills?.length) return 0;
  return estimateValueTokens(
    skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description ?? "",
      tags: skill.tags ?? [],
      path: skill.path ?? "",
    })),
  );
}

function estimateCompactedSummary(summary: string | null | undefined): number {
  if (!summary) return 0;
  return estimateTokens(
    `Here is a summary of the earlier part of this conversation:\n\n${summary}`,
  );
}

/**
 * Estimate the full chat request envelope used by the compaction gauge and
 * auto-compact trigger. This intentionally counts more than visible messages:
 * the actual request includes a system prompt, tool schemas, skill metadata,
 * compacted-summary injection, and sometimes async memory/repo context.
 */
export function estimateChatRequestTokens(
  input: ChatRequestTokenEstimateInput,
): ChatRequestTokenEstimate {
  const messageTokens = estimateMessages(input.messages);
  const systemPromptTokens = estimateTokens(
    input.systemPrompt ?? CHAT_ORCHESTRATOR_BASE_SYSTEM_PROMPT,
  );
  const toolSchemaTokens = estimateValueTokens(input.toolSchemas);
  const skillTokens = estimateSkills(input.skills);
  const compactedSummaryTokens = estimateCompactedSummary(
    input.compactedSummary,
  );
  const dynamicContextReserveTokens = Math.max(
    0,
    input.dynamicContextReserveTokens ?? 0,
  );

  return {
    totalTokens:
      messageTokens +
      systemPromptTokens +
      toolSchemaTokens +
      skillTokens +
      compactedSummaryTokens +
      dynamicContextReserveTokens,
    messageTokens,
    systemPromptTokens,
    toolSchemaTokens,
    skillTokens,
    compactedSummaryTokens,
    dynamicContextReserveTokens,
  };
}
