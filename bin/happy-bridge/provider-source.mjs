// ABOUTME: Adapts the existing provider-runtime WebSocket to neutral sessions.
// ABOUTME: This is the only Phase 2 source implementation; it imports no Happy code.

import WebSocket from "ws";

const RPC_TIMEOUT_MS = 30_000;
const MAX_QUEUED_NOTIFICATIONS = 32;

const PROVIDER_EVENT_KINDS = new Map([
  ["provider://message-chunk", "assistant-delta"],
  ["provider://user-message", "user-message"],
  ["provider://tool-call", "tool-start"],
  ["provider://tool-result", "tool-end"],
  ["provider://diff", "file-diff"],
  ["provider://diff-proposal", "diff-proposal"],
  ["provider://diff-proposal-resolved", "diff-proposal-resolved"],
  ["provider://plan-update", "plan-update"],
  ["provider://permission-request", "permission-request"],
  ["provider://permission-resolved", "permission-resolved"],
  ["provider://prompt-complete", "turn-complete"],
  ["provider://session-status", "status"],
  ["provider://error", "error"],
]);

export function validateBridgeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be an object");
  }

  const providerRuntime = value.providerRuntime;
  if (!providerRuntime || typeof providerRuntime !== "object") {
    throw new Error("config.providerRuntime is required");
  }
  if (typeof providerRuntime.host !== "string" || providerRuntime.host.length === 0) {
    throw new Error("config.providerRuntime.host is required");
  }
  if (
    !Number.isInteger(providerRuntime.port) ||
    providerRuntime.port < 1 ||
    providerRuntime.port > 65535
  ) {
    throw new Error("config.providerRuntime.port must be a valid TCP port");
  }
  if (typeof providerRuntime.token !== "string" || providerRuntime.token.length === 0) {
    throw new Error("config.providerRuntime.token is required");
  }
  if (typeof value.relayUrl !== "string" || value.relayUrl.length === 0) {
    throw new Error("config.relayUrl is required");
  }
  if (typeof value.machineName !== "string" || value.machineName.length === 0) {
    throw new Error("config.machineName is required");
  }
  if (
    value.machineIdentity !== null &&
    (typeof value.machineIdentity !== "object" || Array.isArray(value.machineIdentity))
  ) {
    throw new Error("config.machineIdentity must be an object or null");
  }

  return value;
}

export function translateProviderEvent(method, params = {}) {
  const kind = PROVIDER_EVENT_KINDS.get(method);
  if (!kind || typeof params?.sessionId !== "string") return null;

  const { sessionId, ...payload } = params;
  return { kind, sessionId, payload };
}

class ProviderRuntimeClient {
  constructor(config, { onUnexpectedDisconnect = () => {} } = {}) {
    this.config = config;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.notificationQueue = [];
    this.onUnexpectedDisconnect = onUnexpectedDisconnect;
    this.intentionalClose = false;
    this.disconnectReported = false;
    this.handshakeComplete = false;
  }

  async connect() {
    const { host, port, token } = this.config.providerRuntime;
    this.socket = new WebSocket(`ws://${host}:${port}`);
    this.socket.on("message", (raw) => this.handleMessage(raw));
    this.socket.on("error", () => this.reportUnexpectedDisconnect("error"));
    this.socket.on("close", () => this.reportUnexpectedDisconnect("close"));
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () => reject(new Error("provider runtime connection failed")));
    });
    await this.call("auth", { token });
    this.handshakeComplete = true;
  }

  reportUnexpectedDisconnect(reason) {
    if (this.intentionalClose || !this.handshakeComplete || this.disconnectReported) return;
    this.disconnectReported = true;
    this.onUnexpectedDisconnect(reason);
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (typeof message.method === "string") {
      this.dispatchNotification(message.method, message.params ?? {});
      return;
    }

    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "provider runtime RPC failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  // Registration attaches its subscriber only after several relay round trips.
  // Discarding what arrives first lost the `prompt-complete` of a turn that was
  // already running, leaving the queue for that session marked busy forever.
  dispatchNotification(method, params) {
    if (this.notificationListeners.size === 0) {
      if (this.notificationQueue.length === MAX_QUEUED_NOTIFICATIONS) {
        this.notificationQueue.shift();
      }
      this.notificationQueue.push({ method, params });
      return;
    }
    for (const listener of this.notificationListeners) listener(method, params);
  }

  subscribeNotifications(listener) {
    this.notificationListeners.add(listener);
    while (this.notificationQueue.length > 0) {
      const notification = this.notificationQueue.shift();
      listener(notification.method, notification.params);
    }
    return () => this.notificationListeners.delete(listener);
  }

  call(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("provider runtime socket is not open"));
    }

    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("provider runtime RPC timed out"));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close() {
    this.intentionalClose = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("provider runtime client closed"));
    }
    this.pending.clear();
    this.notificationListeners.clear();
    this.notificationQueue.length = 0;
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve();
    // Resolves on the close handshake rather than returning immediately: the
    // caller exits the process next, and exiting while the socket is still
    // tearing down aborts on Windows inside uv_async_send.
    return new Promise((resolve) => {
      socket.once("close", resolve);
      socket.close(1000, "bridge shutdown");
    });
  }
}

export function createProviderRuntimeClient(config, options) {
  return new ProviderRuntimeClient(config, options);
}

function normalizeSession(session) {
  return {
    sessionId: session.id,
    agentType: session.agentType,
    cwd: session.cwd,
    status: session.status,
    createdAt: session.createdAt,
    ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
    ...(Array.isArray(session.pendingPermissions)
      ? { pendingPermissions: session.pendingPermissions }
      : {}),
  };
}

// codex collapses every mode onto two approval policies: "ask" prompts via
// ActionConfirmation, everything else runs unattended. Only a mode that
// explicitly asks to skip approvals may reach "auto" — anything else, including
// the baseline "default" a remote peer sends by omission, must fail closed to
// "ask" so approval prompts are never dropped silently.
const CODEX_UNATTENDED_MODES = new Set(["auto", "bypassPermissions", "safe-yolo", "yolo"]);

export function providerPermissionMode(mode, agentType) {
  if (agentType === "codex") {
    return CODEX_UNATTENDED_MODES.has(mode) ? "auto" : "ask";
  }
  if (agentType === "gemini") {
    return {
      default: "default",
      acceptEdits: "auto_edit",
      bypassPermissions: "yolo",
      plan: "plan",
      "read-only": "plan",
      "safe-yolo": "yolo",
      yolo: "yolo",
    }[mode] ?? mode;
  }
  if (agentType === "grok") {
    return {
      default: "default",
      auto_edit: "acceptEdits",
      acceptEdits: "acceptEdits",
      dontAsk: "dontAsk",
      bypassPermissions: "bypassPermissions",
      plan: "plan",
      "read-only": "plan",
      "safe-yolo": "bypassPermissions",
      yolo: "bypassPermissions",
    }[mode] ?? mode;
  }
  return mode;
}

export function createProviderSource({ client, config, debugLog = () => {} }) {
  const agentTypes = new Map();

  return {
    async listSessions() {
      const result = await client.call("provider_list_sessions");
      const sessions = Array.isArray(result) ? result : result?.sessions;
      if (!Array.isArray(sessions)) return [];
      const normalized = sessions.map(normalizeSession);
      for (const session of normalized) agentTypes.set(session.sessionId, session.agentType);
      return normalized;
    },

    subscribe(onEvent) {
      return client.subscribeNotifications((method, params) => {
        const event = translateProviderEvent(method, params);
        if (!event) {
          debugLog(`dropped unmapped provider event ${method}`);
          return;
        }
        onEvent(event);
      });
    },

    async sendPrompt(sessionId, text) {
      await client.call("provider_prompt", {
        sessionId,
        prompt: text,
        origin: "remote",
      });
    },

    async cancel(sessionId) {
      await client.call("provider_cancel", { sessionId });
    },

    async respondToPermission(sessionId, requestId, optionId) {
      await client.call("provider_respond_to_permission", {
        sessionId,
        requestId,
        optionId,
        origin: "remote",
      });
      return { ok: true };
    },

    async respondToDiffProposal(sessionId, proposalId, accepted) {
      await client.call("provider_respond_to_diff_proposal", {
        sessionId,
        proposalId,
        accepted,
        origin: "remote",
      });
      return { ok: true };
    },

    async setPermissionMode(sessionId, mode) {
      const agentType = agentTypes.get(sessionId);
      await client.call("provider_set_permission_mode", {
        sessionId,
        mode: providerPermissionMode(mode, agentType),
      });
    },

    async spawn(spec) {
      const result = await client.call("provider_spawn", {
        agentType: spec.agentType,
        cwd: spec.cwd,
        localSessionId: spec.localSessionId ?? null,
        resumeAgentSessionId: spec.resumeAgentSessionId ?? null,
        sandboxMode: spec.sandboxMode ?? null,
        approvalPolicy: spec.approvalPolicy ?? null,
        networkEnabled: spec.networkEnabled ?? null,
        timeoutSecs: spec.timeoutSecs ?? null,
        initialModelId: spec.initialModelId ?? null,
        reasoningEffort: spec.reasoningEffort ?? null,
      });
      const session = normalizeSession(result);
      agentTypes.set(session.sessionId, session.agentType);
      return session;
    },

    async advertise() {
      const result = await client.call("provider_get_available_agents");
      return {
        machineName: config.machineName,
        agents: Array.isArray(result) ? result : result?.agents ?? [],
        roots: [],
      };
    },
  };
}
