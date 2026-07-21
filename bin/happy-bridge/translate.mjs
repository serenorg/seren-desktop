// ABOUTME: Translates provider-neutral session events into Happy wire messages.
// ABOUTME: This module is pure apart from Happy's schema helper and performs no I/O.

import { randomUUID } from "node:crypto";

import { createEnvelope } from "@slopus/happy-wire";

const AGENT_PROVIDER = "codex";
const TOOL_OUTPUT_MAX_CHARS = 1_200;
const TOOL_ERROR_MAX_CHARS = 6_000;
const FILE_DIFF_MAX_CHARS = 2_000;
const MOBILE_TRUNCATION_MARKER = "\n… [truncated for Happy Mobile]";

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function displayText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function boundedMobileText(value, maxChars) {
  const text = displayText(value);
  if (text.length <= maxChars) return text;
  const prefixLength = Math.max(0, maxChars - MOBILE_TRUNCATION_MARKER.length);
  let prefix = text.slice(0, prefixLength);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${MOBILE_TRUNCATION_MARKER}`;
}

function summarizeFileContent(value) {
  if (typeof value !== "string") return undefined;
  const lines = value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length;
  return `[${lines} ${lines === 1 ? "line" : "lines"} hidden on Happy Mobile]`;
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

const ACTIVE_STATUSES = new Set(["prompting", "busy", "running"]);
const TERMINAL_STATUSES = new Set([
  "ready",
  "idle",
  "completed",
  "error",
  "terminated",
]);
const AGENT_SESSION_EVENTS = new Set([
  "assistant-delta",
  "diff-proposal-resolved",
  "plan-update",
  "permission-resolved",
]);

/**
 * Happy requires every agent-originated session envelope to name its turn, but
 * provider runtimes do not consistently include their native turn id on
 * streamed events. Correlate one local id across the prompt attribution,
 * response chunks, and terminal boundary without changing provider state.
 *
 * @param {{createTurnId?: () => string}} options
 */
export function createTurnCorrelator({ createTurnId = randomUUID } = {}) {
  const activeTurns = new Map();

  function correlate(event) {
    if (!event || typeof event !== "object" || typeof event.sessionId !== "string") {
      return event;
    }
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const suppliedTurn = stringValue(payload.turnId) || stringValue(payload.turn);
    let turnId = suppliedTurn || activeTurns.get(event.sessionId);
    const status = event.kind === "status" ? stringValue(payload.status) : "";
    const startsTurn = event.kind === "user-message" || ACTIVE_STATUSES.has(status);
    const needsTurn = startsTurn || AGENT_SESSION_EVENTS.has(event.kind) ||
      event.kind === "turn-complete" || event.kind === "error";

    if (event.kind === "user-message" && !suppliedTurn) {
      turnId = createTurnId();
    } else if (!turnId && needsTurn) {
      turnId = createTurnId();
    }
    if (turnId && (startsTurn || needsTurn)) {
      activeTurns.set(event.sessionId, turnId);
    }

    const correlated = turnId
      ? { ...event, payload: { ...payload, turnId } }
      : event;
    if (
      event.kind === "turn-complete" ||
      event.kind === "error" ||
      TERMINAL_STATUSES.has(status)
    ) {
      activeTurns.delete(event.sessionId);
    }
    return correlated;
  }

  return {
    correlate,
    clear(sessionId) {
      activeTurns.delete(sessionId);
    },
    close() {
      activeTurns.clear();
    },
  };
}

/**
 * Provider `assistant-delta` events are stream fragments, while Happy text
 * envelopes are complete chat messages. Buffer contiguous fragments so one
 * provider response does not become one mobile bubble per token.
 *
 * @param {{createMessageId?: () => string}} options
 */
export function createAssistantMessageCoalescer({ createMessageId = randomUUID } = {}) {
  const pending = new Map();

  function flush(sessionId) {
    const buffered = pending.get(sessionId);
    if (!buffered) return [];
    pending.delete(sessionId);
    return [{
      ...buffered.event,
      payload: {
        ...buffered.payload,
        text: buffered.text,
        messageId: buffered.messageId,
      },
    }];
  }

  function consume(event) {
    if (!event || typeof event !== "object" || typeof event.sessionId !== "string") {
      return [];
    }
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    if (event.kind !== "assistant-delta") {
      return [...flush(event.sessionId), event];
    }

    const text = stringValue(payload.text);
    if (!text) return [];
    const suppliedMessageId = stringValue(payload.messageId);
    const turnId = stringValue(payload.turnId) || stringValue(payload.turn);
    const isThought = payload.isThought === true;
    const buffered = pending.get(event.sessionId);
    const sameMessage = buffered &&
      buffered.turnId === turnId &&
      buffered.isThought === isThought &&
      (!suppliedMessageId || buffered.suppliedMessageId === suppliedMessageId);

    const flushed = sameMessage ? [] : flush(event.sessionId);
    if (sameMessage) {
      buffered.text += text;
      buffered.payload = payload;
    } else {
      pending.set(event.sessionId, {
        event,
        payload,
        text,
        turnId,
        isThought,
        suppliedMessageId,
        messageId: suppliedMessageId || createMessageId(),
      });
    }
    return flushed;
  }

  return {
    consume,
    clear(sessionId) {
      pending.delete(sessionId);
    },
    close() {
      pending.clear();
    },
  };
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
      // Happy already persisted the remote peer's prompt before the bridge
      // received it. Republishing the provider's attribution event would add a
      // second user bubble to the controlling client.
      if (payload.origin === "remote") return [];
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
        output: boundedMobileText(
          payload.error ?? payload.result ?? "",
          payload.error ? TOOL_ERROR_MAX_CHARS : TOOL_OUTPUT_MAX_CHARS,
        ),
        id: stringValue(payload.toolCallId, "unknown-call"),
        ...(payload.error ? { isError: true } : {}),
      }), provider }];
    case "file-diff":
      return [{ ...acp({
        type: "file-edit",
        description: "File change",
        filePath: stringValue(payload.path, "unknown file"),
        diff: typeof payload.newText === "string"
          ? boundedMobileText(payload.newText, FILE_DIFF_MAX_CHARS)
          : undefined,
        oldContent: summarizeFileContent(payload.oldText),
        newContent: summarizeFileContent(payload.newText),
        id: stringValue(payload.toolCallId, "file-change"),
      }), provider }];
    case "diff-proposal":
      return [{ ...acp({
        type: "file-edit",
        description: "File change requires approval",
        filePath: stringValue(payload.path, "unknown file"),
        diff: typeof payload.newText === "string"
          ? boundedMobileText(payload.newText, FILE_DIFF_MAX_CHARS)
          : undefined,
        oldContent: summarizeFileContent(payload.oldText),
        newContent: summarizeFileContent(payload.newText),
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
      {
        const toolCall = payload.toolCall && typeof payload.toolCall === "object"
          ? payload.toolCall
          : {};
      return [{ ...acp({
        type: "permission-request",
        permissionId: stringValue(payload.requestId, "unknown-request"),
        toolName: stringValue(payload.toolName, stringValue(toolCall.name, "tool")),
        description: stringValue(
          payload.description,
          stringValue(toolCall.description, "Approval required"),
        ),
        options: Array.isArray(payload.options) ? payload.options : [],
      }), provider }];
      }
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
      if (["prompting", "busy", "running"].includes(status)) {
        return [eventEnvelope("agent", { t: "turn-start" }, payload, "turn-start")];
      }
      if (["ready", "idle", "completed"].includes(status)) {
        return [eventEnvelope("agent", { t: "turn-end", status: "completed" }, payload, "turn-end")];
      }
      if (["error", "terminated"].includes(status)) {
        return [eventEnvelope("agent", { t: "turn-end", status: "failed" }, payload, "turn-end")];
      }
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
