// ABOUTME: Evidence extractors for final-output validation.
// ABOUTME: Normalizes chat, orchestrator, and local-agent ledgers.

import type { ChatMessageWithTools } from "@/lib/providers/types";
import type { UnifiedMessage } from "@/types/conversation";
import type { DiffEvidence, FinalizationEvidence, ToolEvidence } from "./types";

interface AgentLikeMessage {
  id?: string;
  type: string;
  content?: string;
  timestamp?: number;
  toolCallId?: string;
  toolCall?: {
    toolCallId: string;
    title: string;
    kind: string;
    status: string;
    name?: string;
    result?: string;
    error?: string;
    isError?: boolean;
  };
  diff?: {
    path: string;
    toolCallId?: string;
    sessionId?: string;
    oldText?: string;
    newText?: string;
  };
}

const ERROR_RESULT_RE =
  /(^|\b)(error|failed|failure|denied|rejected|not approved|permission denied|element not found|timed out|timeout)(\b|:)/i;

export function extractEvidenceFromUnifiedMessages(
  messages: readonly UnifiedMessage[],
): FinalizationEvidence {
  const tools: ToolEvidence[] = [];
  const diffs: DiffEvidence[] = [];

  for (const message of messages) {
    if (message.type === "diff" && message.diff) {
      diffs.push({
        path: message.diff.path,
        toolCallId: message.diff.toolCallId ?? message.toolCallId,
      });
    }
    if (message.toolCall) {
      tools.push(
        normalizeToolEvidence({
          id: message.toolCall.toolCallId,
          name: message.toolCall.name ?? message.toolCall.title,
          title: message.toolCall.title,
          kind: message.toolCall.kind,
          status: message.toolCall.status,
          result: message.toolCall.result,
          isError: message.toolCall.isError,
        }),
      );
    }
  }

  return { tools: dedupeTools(tools), diffs };
}

export function extractEvidenceFromAgentMessages(
  messages: readonly AgentLikeMessage[],
): FinalizationEvidence {
  const tools: ToolEvidence[] = [];
  const diffs: DiffEvidence[] = [];

  for (const message of messages) {
    if (message.type === "diff" && message.diff) {
      diffs.push({
        path: message.diff.path,
        toolCallId: message.diff.toolCallId ?? message.toolCallId,
      });
    }
    if (message.toolCall) {
      tools.push(
        normalizeToolEvidence({
          id: message.toolCall.toolCallId,
          name: message.toolCall.name ?? message.toolCall.title,
          title: message.toolCall.title,
          kind: message.toolCall.kind,
          status: message.toolCall.status,
          result: message.toolCall.result ?? message.toolCall.error,
          isError: message.toolCall.isError ?? Boolean(message.toolCall.error),
        }),
      );
    }
  }

  return { tools: dedupeTools(tools), diffs };
}

export function extractEvidenceFromToolLoopMessages(
  messages: readonly ChatMessageWithTools[],
): FinalizationEvidence {
  const calls = new Map<
    string,
    { name: string; title: string; kind: string }
  >();
  const tools: ToolEvidence[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        calls.set(call.id, {
          name: call.function.name,
          title: call.function.name,
          kind: inferKindFromName(call.function.name),
        });
      }
    }
    if (message.role === "tool" && message.tool_call_id) {
      const call = calls.get(message.tool_call_id);
      const content = stringifyContent(message.content);
      tools.push(
        normalizeToolEvidence({
          id: message.tool_call_id,
          name: call?.name ?? "tool",
          title: call?.title ?? "tool",
          kind: call?.kind ?? "tool",
          status: ERROR_RESULT_RE.test(content) ? "error" : "completed",
          result: content,
        }),
      );
    }
  }

  return { tools: dedupeTools(tools), diffs: [] };
}

function normalizeToolEvidence(input: {
  id: string;
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  result?: string;
  isError?: boolean;
}): ToolEvidence {
  const result = input.result;
  const status = input.status || "completed";
  const isError =
    input.isError === true ||
    isErrorStatus(status) ||
    ERROR_RESULT_RE.test(result ?? "");
  return {
    id: input.id,
    name: input.name || input.title || input.kind || "tool",
    title: input.title || input.name || input.kind || "tool",
    kind: input.kind || inferKindFromName(input.name ?? input.title ?? ""),
    status,
    result,
    isError,
  };
}

function dedupeTools(tools: ToolEvidence[]): ToolEvidence[] {
  const byId = new Map<string, ToolEvidence>();
  for (const tool of tools) {
    const existing = byId.get(tool.id);
    if (!existing || existing.result == null) {
      byId.set(tool.id, tool);
      continue;
    }
    if (tool.result != null) {
      byId.set(tool.id, tool);
    }
  }
  return [...byId.values()];
}

function isErrorStatus(status: string): boolean {
  return /error|failed|failure|denied|rejected|cancelled|canceled/i.test(
    status,
  );
}

function inferKindFromName(name: string): string {
  if (/gmail|outlook|email|draft|message/i.test(name)) return "email";
  if (/sql|database|db|serendb|postgres/i.test(name)) return "database";
  if (/playwright|browser|screenshot|click|navigate|fill/i.test(name)) {
    return "browser";
  }
  if (/file|write|edit|patch|diff|directory/i.test(name)) return "file";
  if (/publisher|gateway|mcp/i.test(name)) return "publisher";
  return "tool";
}

function stringifyContent(content: ChatMessageWithTools["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}
