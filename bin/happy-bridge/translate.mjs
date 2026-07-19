// ABOUTME: Translates provider-neutral session events into Happy wire messages.
// ABOUTME: This module is pure apart from Happy's schema helper and performs no I/O.

import { createEnvelope } from "@slopus/happy-wire";

const AGENT_PROVIDER = "codex";

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function eventEnvelope(role, ev, payload, suffix) {
  const id = stringValue(payload?.messageId) ||
    (stringValue(payload?.toolCallId) ? `${payload.toolCallId}-${suffix}` : undefined);
  const turn = stringValue(payload?.turnId) || stringValue(payload?.turn);
  return {
    transport: "session",
    envelope: createEnvelope(role, ev, {
      ...(id ? { id } : {}),
      ...(turn ? { turn } : {}),
      ...(typeof payload?.timestamp === "number" ? { time: payload.timestamp } : {}),
    }),
  };
}

function acp(body) {
  return { transport: "agent", provider: AGENT_PROVIDER, body };
}

function service(payload, text) {
  return eventEnvelope("agent", { t: "service", text }, payload, "service");
}

/**
 * Convert exactly one neutral event. The returned list is deliberate: a
 * completion can carry both a turn boundary and usage metadata.
 *
 * @param {{kind: string, sessionId: string, payload?: Record<string, unknown>}} event
 * @returns {Array<Record<string, unknown>>}
 */
export function translateNeutralEvent(event, { provider = AGENT_PROVIDER } = {}) {
  if (!event || typeof event !== "object" || typeof event.kind !== "string") {
    return [];
  }
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const text = stringValue(payload.text);

  switch (event.kind) {
    case "assistant-delta":
      if (!text) return [];
      return [eventEnvelope("agent", {
        t: "text",
        text,
        ...(payload.isThought === true ? { thinking: true } : {}),
      }, payload, "text")];
    case "user-message":
      if (!text) return [];
      return [eventEnvelope("user", { t: "text", text }, payload, "user")];
    case "tool-start":
      return [{ ...acp({
        type: "tool-call",
        callId: stringValue(payload.toolCallId, "unknown-call"),
        name: stringValue(payload.name, stringValue(payload.kind, "tool")),
        input: payload.parameters ?? {},
        id: stringValue(payload.toolCallId, "unknown-call"),
      }), provider }];
    case "tool-end":
      return [{ ...acp({
        type: "tool-result",
        callId: stringValue(payload.toolCallId, "unknown-call"),
        output: payload.error ?? payload.result ?? "",
        id: stringValue(payload.toolCallId, "unknown-call"),
        ...(payload.error ? { isError: true } : {}),
      }), provider }];
    case "file-diff":
      return [{ ...acp({
        type: "file-edit",
        description: "File change",
        filePath: stringValue(payload.path, "unknown file"),
        diff: typeof payload.newText === "string" ? payload.newText : undefined,
        oldContent: typeof payload.oldText === "string" ? payload.oldText : undefined,
        newContent: typeof payload.newText === "string" ? payload.newText : undefined,
        id: stringValue(payload.toolCallId, "file-change"),
      }), provider }];
    case "diff-proposal":
      return [{ ...acp({
        type: "file-edit",
        description: "File change requires approval",
        filePath: stringValue(payload.path, "unknown file"),
        diff: typeof payload.newText === "string" ? payload.newText : undefined,
        oldContent: typeof payload.oldText === "string" ? payload.oldText : undefined,
        newContent: typeof payload.newText === "string" ? payload.newText : undefined,
        id: stringValue(payload.proposalId, "file-proposal"),
      }), provider }];
    case "diff-proposal-resolved":
      return [service(payload, `File change ${stringValue(payload.status, "resolved")}.`)];
    case "plan-update": {
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      const summary = entries
        .map((entry) => `${stringValue(entry?.status, "pending")}: ${stringValue(entry?.content)}`)
        .join("\n");
      return [service(payload, summary ? `Plan updated:\n${summary}` : "Plan updated.")];
    }
    case "permission-request":
      return [{ ...acp({
        type: "permission-request",
        permissionId: stringValue(payload.requestId, "unknown-request"),
        toolName: stringValue(payload.toolName, "tool"),
        description: stringValue(payload.description, "Approval required"),
        options: Array.isArray(payload.options) ? payload.options : [],
      }), provider }];
    case "permission-resolved":
      return [service(payload, "Approval resolved.")];
    case "turn-complete": {
      const stopReason = stringValue(payload.stopReason, "completed").toLowerCase();
      const status = stopReason.includes("cancel")
        ? "cancelled"
        : stopReason.includes("error") || stopReason.includes("fail")
          ? "failed"
          : "completed";
      const messages = [eventEnvelope("agent", { t: "turn-end", status }, payload, "turn-end")];
      if (payload.meta?.usage) {
        messages.push({ ...acp({ type: "token_count", ...payload.meta.usage }), provider });
      }
      return messages;
    }
    case "status": {
      const status = stringValue(payload.status, "unknown");
      return [service(payload, `Session status: ${status}`)];
    }
    case "error":
      return [service(payload, `Session error: ${stringValue(payload.error, "unknown error")}`)];
    default:
      return [];
  }
}

/**
 * Push copy is intentionally independent of session metadata. The output may
 * be sent through Happy's relay, so it must not carry titles, tools, projects,
 * working directories, URLs, or request contents.
 */
export function composeApprovalNotification() {
  return {
    title: "Approval needed",
    body: "Approval needed",
    data: { kind: "permission" },
  };
}
