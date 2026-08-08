// ABOUTME: Pure prompt-text builders for fork and dropped-prompt-recovery bootstraps.
// ABOUTME: Behavior-preserving extraction from agent.store; no store state closure.

import type { ActiveSession, AgentMessage } from "@/stores/agent.store";

const FORK_BOOTSTRAP_MAX_MSG_CHARS = 2_000;

export function agentDisplayName(agentType?: string): string {
  switch (agentType) {
    case "codex":
      return "Codex";
    case "claude-code":
      return "Claude Code";
    case "gemini":
      return "Antigravity";
    case "grok":
      return "Grok";
    case "claude-codex":
      return "Claude + Codex";
    case "planner-runner":
      return "Planner + Runner";
    case "lmstudio":
      return "LM Studio";
    default:
      return agentType ?? "Agent";
  }
}

export function agentInitializationFailureMessage(agentType?: string): string {
  const agentName = agentDisplayName(agentType);
  const remediation =
    agentType === "codex"
      ? "Codex is installed and signed in"
      : agentType === "gemini"
        ? "Antigravity is installed and signed in"
        : agentType === "grok"
          ? "Grok is installed and signed in"
          : agentType === "lmstudio"
            ? "LM Studio is running and reachable"
            : agentType === "claude-codex" || agentType === "planner-runner"
              ? "Claude Code and Codex are installed and signed in"
              : `${agentName} is installed and authenticated`;

  return `Agent session terminated before initialization completed. Check that ${remediation}.`;
}

function truncateBootstrapText(content: string): string {
  return content.length > FORK_BOOTSTRAP_MAX_MSG_CHARS
    ? `${content.slice(0, FORK_BOOTSTRAP_MAX_MSG_CHARS)}... [truncated]`
    : content;
}

function formatForkBootstrapMessage(message: AgentMessage): string | null {
  const content = message.content.trim();

  switch (message.type) {
    case "user":
      return content ? `USER: ${truncateBootstrapText(content)}` : null;
    case "assistant":
      return content ? `ASSISTANT: ${truncateBootstrapText(content)}` : null;
    case "error":
      return content ? `SYSTEM: ${truncateBootstrapText(content)}` : null;
    case "tool": {
      const label = message.toolCall?.status
        ? `TOOL (${message.toolCall.status})`
        : "TOOL";
      return content ? `${label}: ${truncateBootstrapText(content)}` : null;
    }
    case "diff": {
      const path = message.diff?.path;
      const summary = path ? `Modified ${path}` : content;
      return summary ? `DIFF: ${truncateBootstrapText(summary)}` : null;
    }
    case "handoff":
      return content ? `SYSTEM: ${truncateBootstrapText(content)}` : null;
    case "thought":
      return null;
  }
}

export function buildForkBootstrapContext(
  session: ActiveSession,
  messages: AgentMessage[],
): string | null {
  const summary = session.compactedSummary?.content.trim();
  const transcript = messages
    .map(formatForkBootstrapMessage)
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  if (!summary && !transcript) {
    return null;
  }

  const sections = [
    "This prompt continues a forked branch of an earlier coding-agent conversation.",
    "Treat the summary and transcript below as the authoritative history for this branch.",
    "Anything that happened after the branch point is not part of this branch.",
  ];

  if (summary) {
    sections.push(`Earlier summary:\n${summary}`);
  }

  if (transcript) {
    sections.push(`Branch transcript:\n${transcript}`);
  }

  sections.push(
    "Continue from the branch transcript's final message. Do not mention this bootstrap unless it helps answer the user.",
  );

  return sections.join("\n\n");
}

export function isSessionDeathMessage(message: string): boolean {
  return (
    message.includes("Session terminated") ||
    message.includes("stopped before request completed") ||
    message.includes("stopped while prompt was active") ||
    message.includes("Worker thread dropped")
  );
}

export function isRecoverableDeadSessionSendFailure(message: string): boolean {
  if (message.includes("Task cancelled")) {
    return false;
  }
  return (
    message.includes("unresponsive") ||
    message.includes("Worker thread dropped") ||
    message.includes("not found") ||
    message.includes("Session not initialized")
  );
}

export function filterDroppedPromptRecoveryMessages(
  messages: AgentMessage[],
): AgentMessage[] {
  return messages.filter((message) => {
    if (message.type !== "error") {
      return true;
    }
    return (
      !message.content.includes("unresponsive") &&
      !isSessionDeathMessage(message.content)
    );
  });
}

export function mergeRecoveryMessages(
  liveMessages: AgentMessage[],
  persistedMessages: AgentMessage[],
): AgentMessage[] {
  const byId = new Map<string, AgentMessage>();
  for (const message of persistedMessages) {
    byId.set(message.id, message);
  }
  for (const message of liveMessages) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export function buildDroppedPromptRecoveryBootstrapContext(
  session: ActiveSession,
  messages: AgentMessage[],
  reason: string,
  persistedContext: string,
): string | null {
  const summary = session.compactedSummary?.content.trim();
  const transcript = messages
    .map(formatForkBootstrapMessage)
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  if (!summary && !transcript && !persistedContext.trim()) {
    return null;
  }

  const sections = [
    "Seren Desktop restarted the coding-agent worker while a prompt was active.",
    `Recovery reason: ${truncateBootstrapText(reason)}`,
    "Use the recovered history below as authoritative context for the restarted worker.",
    "The user's original prompt will be replayed automatically after this context; do not ask the user to type continue.",
  ];

  if (summary) {
    sections.push(`Earlier summary:\n${summary}`);
  }

  if (transcript) {
    sections.push(`Recovered transcript:\n${transcript}`);
  } else if (persistedContext.trim()) {
    sections.push(`Persisted transcript fallback:\n${persistedContext}`);
  }

  sections.push(
    "Continue the interrupted task from the recovered context and the replayed prompt.",
  );

  return sections.join("\n\n");
}
