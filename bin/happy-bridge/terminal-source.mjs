// ABOUTME: Exposes the desktop's Claude/Codex terminal panes as neutral remote sessions.
// ABOUTME: Reads their CLI transcripts; the panes themselves stay owned by the desktop.

import { open, stat } from "node:fs/promises";

import { transcriptParserFor } from "./terminal-transcript.mjs";

const POLL_INTERVAL_MS = 2_000;
// A pane's transcript can be megabytes of history. Replay enough to make the
// thread readable on a phone, not the whole file.
const HISTORY_EVENT_LIMIT = 40;
const READ_CHUNK_BYTES = 1024 * 1024;
// A prompt sent from a phone comes back in the CLI transcript with nothing to
// say where it came from. Remember it just long enough to recognize the echo;
// past this the CLI clearly never wrote it and the entry is dead weight.
const ECHO_TTL_MS = 5 * 60_000;
const MAX_TRACKED_ECHOES = 16;

const REMOTE_UNSUPPORTED =
  "This is a terminal pane on the desktop. Type into it there.";

/**
 * Approval options are numbered on screen, so their ids are digits and match
 * none of the layer's affirmative/deny vocabularies. Classifying the label
 * gives `selectApprovalOption` something to reason about when a phone answers
 * with a plain approve/deny rather than naming an option.
 */
export function classifyApprovalOption(label) {
  const text = String(label ?? "").toLowerCase();
  if (/^(no|don't|do not|cancel|reject|deny)\b/.test(text)) return "reject_once";
  if (/don't ask again|allow all|remember|this session|future|always/.test(text)) {
    return "allow_always";
  }
  return "allow_once";
}

function approvalEventPayload(approval) {
  const options = (Array.isArray(approval?.options) ? approval.options : []).map(
    (option) => ({
      optionId: option.optionId,
      name: option.label,
      kind: classifyApprovalOption(option.label),
    }),
  );
  return {
    requestId: approval.requestId,
    toolName: "Terminal approval",
    description: approval.question,
    options,
  };
}

function normalizeSession(session) {
  return {
    sessionId: session.sessionId,
    agentType: session.agentType,
    cwd: session.cwd,
    title: typeof session.title === "string" && session.title.length > 0 ? session.title : undefined,
    status: "idle",
    ...(typeof session.agentSessionId === "string" && session.agentSessionId.length > 0
      ? { agentSessionId: session.agentSessionId }
      : {}),
  };
}

/**
 * A terminal pane is driven from the desktop keyboard, so this source is
 * read-only. Every write-shaped method rejects rather than silently succeeding:
 * a remote peer must learn its prompt went nowhere.
 *
 * @param {{supervisorChannel: {call: (method: string, params?: object) => Promise<any>}, debugLog?: (message: string) => void}} options
 */
export function createTerminalSource({ supervisorChannel, debugLog = () => {} }) {
  /** @type {Map<string, {summary: object, path: string|null, offset: number, pending: string, replayed: boolean, announced: boolean, busy: boolean, echoes: Array<{text: string, at: number}>}>} */
  const tracked = new Map();

  /**
   * Happy renders the peer's own prompt the moment it is sent, and the CLI then
   * writes that same text into its transcript. Marking the echo as remote lets
   * `translate.mjs` drop it, which is the difference between one bubble and two.
   */
  function claimEcho(entry, text) {
    const now = Date.now();
    let claimed = false;
    entry.echoes = entry.echoes.filter((echo) => {
      if (now - echo.at > ECHO_TTL_MS) return false;
      if (claimed || echo.text !== text) return true;
      claimed = true;
      return false;
    });
    return claimed;
  }

  function rememberEcho(entry, text) {
    entry.echoes.push({ text, at: Date.now() });
    // A prompt whose echo never arrives must not pin the list forever.
    if (entry.echoes.length > MAX_TRACKED_ECHOES) entry.echoes.shift();
  }
  let listeners = new Set();
  let pollTimer = null;
  let polling = false;
  let closed = false;

  async function listRaw() {
    const response = await supervisorChannel.call("terminal_list_sessions", {});
    const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
    return sessions.filter(
      (session) =>
        typeof session?.sessionId === "string" &&
        typeof session?.cwd === "string" &&
        typeof transcriptParserFor(session?.agentType) === "function",
    );
  }

  function emit(event) {
    for (const listener of listeners) listener(event);
  }

  async function resolveTranscriptPath(sessionId) {
    try {
      const response = await supervisorChannel.call("terminal_transcript_path", { sessionId });
      return typeof response?.path === "string" && response.path.length > 0 ? response.path : null;
    } catch {
      // The pane left the advertised roots, or the CLI has not written its
      // transcript yet. Both resolve on a later tick.
      return null;
    }
  }

  /** Read from `offset` to end of file, returning whole lines plus any partial tail. */
  async function readNewLines(entry) {
    const info = await stat(entry.path);
    if (info.size < entry.offset) {
      // Truncated or replaced underneath us. Re-anchor rather than replay a
      // file whose earlier bytes are already published.
      entry.offset = info.size;
      entry.pending = "";
      return [];
    }
    if (info.size === entry.offset) return [];

    const handle = await open(entry.path, "r");
    try {
      let text = entry.pending;
      let position = entry.offset;
      while (position < info.size) {
        const length = Math.min(READ_CHUNK_BYTES, info.size - position);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        text += buffer.subarray(0, bytesRead).toString("utf8");
      }
      entry.offset = position;
      const lines = text.split("\n");
      // A live CLI flushes mid-line; hold the remainder for the next read.
      entry.pending = lines.pop() ?? "";
      return lines;
    } finally {
      await handle.close();
    }
  }

  function parseLines(entry, lines) {
    const parse = transcriptParserFor(entry.summary.agentType);
    const events = [];
    for (const line of lines) {
      for (const event of parse(line)) events.push(event);
    }
    return events;
  }

  /**
   * Publish parsed events, tracking the busy/idle state the transcript implies
   * so the phone's activity indicator matches the pane.
   */
  function publish(sessionId, entry, events, { includeStatus }) {
    for (const event of events) {
      if (event.kind === "status") {
        entry.busy = event.payload?.status === "busy";
        if (!includeStatus) continue;
      }
      if (event.kind === "turn-complete") entry.busy = false;
      emitTranscriptEvent(sessionId, entry, event);
    }
  }

  /**
   * Every transcript-derived event leaves through here so echo suppression can
   * never be bypassed by a second emit path — including history replay, which a
   * prompt sent moments earlier can still land in.
   */
  function emitTranscriptEvent(sessionId, entry, event, extra = {}) {
    const origin =
      event.kind === "user-message" && claimEcho(entry, event.payload?.text)
        ? { origin: "remote" }
        : {};
    emit({
      kind: event.kind,
      sessionId,
      payload: { ...event.payload, ...extra, ...origin },
    });
  }

  async function replayHistory(sessionId, entry) {
    const lines = await readNewLines(entry);
    const events = parseLines(entry, lines);
    // Status events during replay would post a turn-start/turn-end pair for
    // every historical turn. Track the state, publish only the final one.
    const publishable = events.filter((event) => event.kind !== "status");
    const trimmed = publishable.slice(-HISTORY_EVENT_LIMIT);
    for (const event of events) {
      if (event.kind === "status") entry.busy = event.payload?.status === "busy";
      if (event.kind === "turn-complete") entry.busy = false;
    }
    for (const event of trimmed) {
      emitTranscriptEvent(sessionId, entry, event, { replay: true });
    }
    entry.replayed = true;
    emit({
      kind: "status",
      sessionId,
      payload: { status: entry.busy ? "busy" : "idle" },
    });
  }

  /**
   * Approvals are drawn on screen and never written to either CLI's transcript,
   * so they are polled from the rendered grid rather than read from the tail.
   */
  async function syncApproval(sessionId, entry) {
    let approval = null;
    try {
      const response = await supervisorChannel.call("terminal_pending_approval", {
        sessionId,
      });
      approval = response?.approval ?? null;
    } catch (error) {
      debugLog(`terminal approval poll failed: ${error}`);
      return;
    }

    const requestId = approval?.requestId ?? null;
    if (requestId === entry.approvalRequestId) return;

    if (entry.approvalRequestId) {
      // Answered on the desktop, or replaced by a different prompt. Either way
      // the card the phone is showing is no longer actionable.
      emit({
        kind: "permission-resolved",
        sessionId,
        payload: { requestId: entry.approvalRequestId },
      });
    }
    entry.approvalRequestId = requestId;
    if (approval) {
      emit({
        kind: "permission-request",
        sessionId,
        payload: approvalEventPayload(approval),
      });
    }
  }

  async function advance(sessionId, entry) {
    if (!entry.path) {
      entry.path = await resolveTranscriptPath(sessionId);
      if (!entry.path) return;
    }
    if (!entry.replayed) {
      await replayHistory(sessionId, entry);
      return;
    }
    const lines = await readNewLines(entry);
    if (lines.length === 0) return;
    const wasBusy = entry.busy;
    const events = parseLines(entry, lines);
    publish(sessionId, entry, events, { includeStatus: true });
    // A turn that ended without an explicit completion still has to clear the
    // phone's spinner.
    if (wasBusy && !entry.busy) {
      emit({ kind: "status", sessionId, payload: { status: "idle" } });
    }
  }

  async function poll() {
    if (polling || closed) return;
    polling = true;
    try {
      const listed = await listRaw();
      const seen = new Set();
      for (const raw of listed) {
        const summary = normalizeSession(raw);
        seen.add(summary.sessionId);
        let entry = tracked.get(summary.sessionId);
        if (!entry) {
          entry = {
            summary,
            path: null,
            offset: 0,
            pending: "",
            replayed: false,
            announced: false,
            busy: false,
            echoes: [],
            approvalRequestId: null,
          };
          tracked.set(summary.sessionId, entry);
          // Announce first and read on the next tick. The layer resolves a
          // session's summary lazily; letting that resolution happen before
          // history is emitted keeps the replay in order.
          entry.announced = true;
          emit({ kind: "status", sessionId: summary.sessionId, payload: { status: "idle" } });
          continue;
        }
        entry.summary = { ...summary, status: entry.busy ? "busy" : "idle" };
        try {
          await advance(summary.sessionId, entry);
        } catch (error) {
          debugLog(`terminal transcript read failed: ${error}`);
        }
        await syncApproval(summary.sessionId, entry);
      }
      for (const [sessionId, entry] of tracked) {
        if (seen.has(sessionId)) continue;
        tracked.delete(sessionId);
        // The pane exited or left the advertised roots. Either way the remote
        // session is over.
        if (entry.announced) {
          emit({ kind: "status", sessionId, payload: { status: "terminated" } });
        }
      }
    } catch (error) {
      debugLog(`terminal session poll failed: ${error}`);
    } finally {
      polling = false;
    }
  }

  function rejectRemoteWrite() {
    return Promise.reject(new Error(REMOTE_UNSUPPORTED));
  }

  return {
    async listSessions() {
      const listed = await listRaw();
      return listed.map((session) => {
        const summary = normalizeSession(session);
        const entry = tracked.get(summary.sessionId);
        return entry ? { ...summary, status: entry.busy ? "busy" : "idle" } : summary;
      });
    },

    subscribe(onEvent) {
      listeners.add(onEvent);
      if (!pollTimer && !closed) {
        void poll();
        pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
        // The bridge must still exit when nothing else is pending.
        pollTimer.unref?.();
      }
      return () => listeners.delete(onEvent);
    },

    async sendPrompt(sessionId, text) {
      const entry = tracked.get(sessionId);
      if (!entry) throw new Error("terminal session is no longer available");
      const response = await supervisorChannel.call("terminal_submit_prompt", {
        sessionId,
        prompt: text,
      });
      if (response?.accepted !== true) {
        throw new Error("The terminal pane did not accept the prompt.");
      }
      // Track what was actually typed, not what was sent: sanitization may have
      // changed it, and the transcript will echo the typed form.
      rememberEcho(entry, typeof response.prompt === "string" ? response.prompt : text);
      entry.busy = true;
      return { accepted: true, sessionId };
    },

    async respondToPermission(sessionId, requestId, optionId) {
      const entry = tracked.get(sessionId);
      if (!entry) throw new Error("terminal session is no longer available");
      // Rust re-reads the screen and refuses if the prompt changed, so a stale
      // answer cannot land on whatever replaced it.
      await supervisorChannel.call("terminal_respond_to_approval", {
        sessionId,
        requestId,
        optionId,
      });
      entry.approvalRequestId = null;
      emit({ kind: "permission-resolved", sessionId, payload: { requestId } });
      return { ok: true };
    },

    respondToDiffProposal: rejectRemoteWrite,
    spawn: rejectRemoteWrite,

    async cancel() {
      // Interrupting a pane means sending it a signal, which is a write.
      throw new Error(REMOTE_UNSUPPORTED);
    },

    async terminate(sessionId) {
      // Detach only. A phone dismissing a thread must never kill a terminal the
      // user is working in on the desktop.
      tracked.delete(sessionId);
    },

    async setPermissionMode() {
      // A running TUI owns its own permission mode; nothing to change remotely.
    },

    async advertise() {
      return { machineName: "", agents: [], roots: [] };
    },

    close() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      listeners = new Set();
      tracked.clear();
    },
  };
}
