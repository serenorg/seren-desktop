// ABOUTME: Adapts the existing provider-runtime WebSocket to neutral sessions.
// ABOUTME: This is the only Phase 2 source implementation; it imports no Happy code.

import WebSocket from "ws";

const RPC_TIMEOUT_MS = 30_000;

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
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.notificationListeners = new Set();
  }

  async connect() {
    const { host, port, token } = this.config.providerRuntime;
    this.socket = new WebSocket(`ws://${host}:${port}`);
    this.socket.on("message", (raw) => this.handleMessage(raw));
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", () => reject(new Error("provider runtime connection failed")));
    });
    await this.call("auth", { token });
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.notificationListeners) {
        listener(message.method, message.params ?? {});
      }
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

  subscribeNotifications(listener) {
    this.notificationListeners.add(listener);
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
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("provider runtime client closed"));
    }
    this.pending.clear();
    this.notificationListeners.clear();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "bridge shutdown");
    }
    this.socket = null;
  }
}

export function createProviderRuntimeClient(config) {
  return new ProviderRuntimeClient(config);
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

export function createProviderSource({ client, config, debugLog = () => {} }) {
  return {
    async listSessions() {
      const result = await client.call("provider_list_sessions");
      const sessions = Array.isArray(result) ? result : result?.sessions;
      return Array.isArray(sessions) ? sessions.map(normalizeSession) : [];
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
      await client.call("provider_prompt", { sessionId, prompt: text });
    },

    async cancel(sessionId) {
      await client.call("provider_cancel", { sessionId });
    },

    async respondToPermission(sessionId, requestId, optionId) {
      await client.call("provider_respond_to_permission", {
        sessionId,
        requestId,
        optionId,
      });
      return { ok: true };
    },

    async setPermissionMode(sessionId, mode) {
      await client.call("provider_set_permission_mode", { sessionId, mode });
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
      return normalizeSession(result);
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
