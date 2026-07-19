// ABOUTME: Owns the narrow Happy client, session stream, and hosted-relay adapter.
// ABOUTME: Pairing material crosses the supervisor channel only and is never logged.

import { randomUUID } from "node:crypto";
import os from "node:os";
import { ApiClient, configuration } from "happy/lib";
import nacl from "tweetnacl";

import { translateNeutralEvent, composeApprovalNotification } from "./translate.mjs";
import { validatePermissionResponse, validateSpawnRoot } from "./validate.mjs";

const AUTH_POLL_MS = 1000;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CODEX_APPROVAL_POLICY = "on-failure";
const DENY_OPTION_IDS = new Set([
  "deny",
  "decline",
  "reject",
  "reject_once",
  "reject_always",
  "cancel",
]);
// These are the affirmative option ids currently emitted by the supported
// desktop runtimes. Prefer the one-turn variant whenever it is offered.
const NARROW_ALLOW_OPTION_IDS = new Set([
  "accept",
  "accept_once",
  "allow_once",
  "allow-once",
  "approve",
]);
const NARROW_ALLOW_KINDS = new Set(["allow_once", "allow-once"]);

function encodeBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function encodeBase64Url(bytes) {
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64(value) {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function decodeByteValue(value) {
  if (typeof value === "string") return decodeBase64(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value && typeof value === "object") return new Uint8Array(Object.values(value));
  throw new Error("invalid Happy credential bytes");
}

function credentialsFromIdentity(identity) {
  if (!identity || typeof identity !== "object" || typeof identity.token !== "string") {
    throw new Error("Happy identity is incomplete");
  }
  const encryption = identity.encryption;
  if (encryption?.type === "dataKey") {
    return {
      token: identity.token,
      encryption: {
        type: "dataKey",
        publicKey: decodeByteValue(encryption.publicKey),
        machineKey: decodeByteValue(encryption.machineKey),
      },
    };
  }
  const secret = encryption?.secret ?? identity.secret;
  if (encryption?.type === "legacy" || secret) {
    return {
      token: identity.token,
      encryption: { type: "legacy", secret: decodeByteValue(secret) },
    };
  }
  throw new Error("Happy identity has no supported encryption material");
}

function decryptAuthResponse(encoded, secretKey) {
  const bundle = decodeBase64(encoded);
  const ephemeralPublicKey = bundle.slice(0, 32);
  const nonce = bundle.slice(32, 56);
  const ciphertext = bundle.slice(56);
  return nacl.box.open(ciphertext, nonce, ephemeralPublicKey, secretKey);
}

function identityFromAuthResponse(token, decrypted) {
  if (!decrypted) throw new Error("Happy pairing response could not be decrypted");
  const machineId = randomUUID();
  if (decrypted.length === 32) {
    return { token, machineId, encryption: { type: "legacy", secret: encodeBase64(decrypted) } };
  }
  if (decrypted.length === 33 && decrypted[0] === 0) {
    return {
      token,
      machineId,
      encryption: {
        type: "dataKey",
        publicKey: encodeBase64(decrypted.slice(1)),
        machineKey: encodeBase64(nacl.randomBytes(32)),
      },
    };
  }
  throw new Error("Happy pairing response used an unsupported credential format");
}

async function postAuthRequest(relayUrl, publicKey) {
  const response = await fetch(`${relayUrl}/v1/auth/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Happy-Client": "seren-desktop/phase-3" },
    body: JSON.stringify({ publicKey: encodeBase64(publicKey), supportsV2: true }),
  });
  if (!response.ok) throw new Error(`Happy pairing request rejected (${response.status})`);
}

async function readAuthRequest(relayUrl, publicKey) {
  const response = await fetch(`${relayUrl}/v1/auth/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Happy-Client": "seren-desktop/phase-3" },
    body: JSON.stringify({ publicKey: encodeBase64(publicKey), supportsV2: true }),
  });
  if (!response.ok) throw new Error(`Happy pairing status rejected (${response.status})`);
  return response.json();
}

function machineMetadata(config, capabilities = { agents: [], roots: [] }) {
  return {
    host: config.machineName,
    platform: `${process.platform}-${process.arch}`,
    happyCliVersion: "1.2.0",
    homeDir: os.homedir(),
    happyHomeDir: os.homedir(),
    happyLibDir: "seren-desktop",
    remoteCapabilities: capabilities,
  };
}

function happyAgentType(agent) {
  if (agent === "claude") return "claude-code";
  if (agent === "gemini") return "gemini";
  if (agent === "codex") return "codex";
  return typeof agent === "string" && agent.length > 0 ? agent : "claude-code";
}

function defaultApprovalPolicy(agentType) {
  // Match the desktop's fresh-session defaults. Codex is explicitly
  // on-failure; Claude and Gemini resolve their normal defaults in their
  // runtimes when no stricter policy is supplied.
  return agentType === "codex" ? DEFAULT_CODEX_APPROVAL_POLICY : undefined;
}

export function selectApprovalOption(options, approved) {
  const normalized = (Array.isArray(options) ? options : [])
    .map((option) => (typeof option === "string" ? { optionId: option } : option))
    .filter((option) => typeof option?.optionId === "string");
  if (!approved) {
    return normalized.find(
      (option) =>
        DENY_OPTION_IDS.has(option.optionId) ||
        DENY_OPTION_IDS.has(option.kind) ||
        DENY_OPTION_IDS.has(option.description),
    )?.optionId;
  }

  const narrow = normalized.find(
    (option) =>
      NARROW_ALLOW_OPTION_IDS.has(option.optionId) ||
      NARROW_ALLOW_KINDS.has(option.kind) ||
      NARROW_ALLOW_KINDS.has(option.description),
  );
  return narrow?.optionId ?? normalized.find(
    (option) =>
      !DENY_OPTION_IDS.has(option.optionId) &&
      !DENY_OPTION_IDS.has(option.kind) &&
      !DENY_OPTION_IDS.has(option.description),
  )?.optionId;
}

function sessionMetadata(config, summary, machineId) {
  const cwd = typeof summary.cwd === "string" && summary.cwd.length > 0 ? summary.cwd : os.homedir();
  return {
    path: cwd,
    host: config.machineName,
    name: summary.title ?? `${summary.agentType ?? "Agent"} session`,
    version: "seren-desktop",
    os: process.platform,
    machineId,
    homeDir: os.homedir(),
    happyHomeDir: os.homedir(),
    happyLibDir: "seren-desktop",
    lifecycleState: "running",
    lifecycleStateSince: Date.now(),
  };
}

export function createTerminatedSessionTracker(maxSize = 256) {
  const terminated = new Set();
  const order = [];
  return {
    mark(sessionId) {
      if (terminated.has(sessionId)) return;
      terminated.add(sessionId);
      order.push(sessionId);
      while (order.length > maxSize) terminated.delete(order.shift());
    },
    forget(sessionId) {
      if (!terminated.delete(sessionId)) return;
      const index = order.indexOf(sessionId);
      if (index >= 0) order.splice(index, 1);
    },
    has(sessionId) {
      return terminated.has(sessionId);
    },
    clear() {
      terminated.clear();
      order.length = 0;
    },
  };
}

export function createStartupStatusGate(notify) {
  return {
    async complete(startupWork) {
      try {
        const result = await startupWork();
        notify({ state: "connected", detail: "Connected" });
        return result;
      } catch (error) {
        notify({ state: "error", detail: "startup failed" });
        throw error;
      }
    },
  };
}

export function createHappyLayer({
  config,
  supervisorChannel,
  source,
  debugLog = () => {},
}) {
  configuration.serverUrl = config.relayUrl;
  let identity = config.machineIdentity;
  let api = null;
  let machineClient = null;
  let pairingPromise = null;
  let latestPairingPayload = null;
  let sourceSubscription = null;
  let supervisorSubscription = null;
  let advertisedRoots = [];
  let advertisedAgents = [];
  const startupStatusGate = createStartupStatusGate((status) => {
    supervisorChannel.notify("status_report", status);
  });
  const sessions = new Map();
  const sessionCreationPromises = new Map();
  const terminatedSessions = createTerminatedSessionTracker();
  const pendingRequests = Object.create(null);
  const liveSessions = new Set();

  function debug(message) {
    debugLog(message);
  }

  function rememberPermission(event) {
    if (event.kind === "permission-request") {
      const options = Array.isArray(event.payload?.options) ? event.payload.options : [];
      if (!pendingRequests[event.sessionId]) pendingRequests[event.sessionId] = Object.create(null);
      if (typeof event.payload?.requestId !== "string") return;
      pendingRequests[event.sessionId][event.payload.requestId] = {
        optionIds: options.map((option) => option?.optionId ?? option?.id).filter(Boolean),
        options,
      };
    } else if (event.kind === "permission-resolved") {
      delete pendingRequests[event.sessionId]?.[event.payload?.requestId];
    }
  }

  function rememberPendingPermissions(sessionId, permissions) {
    if (!Array.isArray(permissions)) return;
    for (const permission of permissions) {
      if (typeof permission?.requestId !== "string") continue;
      rememberPermission({
        kind: "permission-request",
        sessionId,
        payload: permission,
      });
    }
  }

  function registerInbound(entry) {
    const { client } = entry;
    client.onUserMessage((message) => {
      void handleUserMessage(entry, message).catch(() => debug("ignored Happy inbound user message"));
    });
    client.rpcHandlerManager.registerHandler("abort", async () => {
      try {
        await source.cancel(entry.sessionId);
        return { ok: true };
      } catch {
        debug("ignored failed Happy abort request");
        return { ok: false };
      }
    });
    client.rpcHandlerManager.registerHandler("switch", async () => {
      try {
        await source.cancel(entry.sessionId);
        return { ok: true };
      } catch {
        debug("ignored failed Happy switch request");
        return { ok: false };
      }
    });
    client.rpcHandlerManager.registerHandler("permission", async (response) => {
      try {
        return await handlePermissionResponse(entry, response);
      } catch {
        debug("ignored failed Happy permission request");
        return { ok: false };
      }
    });
  }

  async function handleUserMessage(entry, message) {
    if (message?.role !== "user" || message?.content?.type !== "text") {
      debug("dropped invalid Happy user message");
      return;
    }
    if (typeof message.content.text !== "string" || message.content.text.length === 0) {
      debug("dropped empty Happy user message");
      return;
    }
    const mode = message.meta?.permissionMode;
    if (message.meta && mode !== undefined && typeof mode !== "string") {
      debug("dropped invalid Happy permission mode");
      return;
    }
    if (typeof mode === "string") await source.setPermissionMode(entry.sessionId, mode);
    await source.sendPrompt(entry.sessionId, message.content.text);
  }

  async function handlePermissionResponse(entry, response) {
    const requestId = response?.id ?? response?.requestId;
    const sessionId = entry.sessionId;
    const offered = pendingRequests[sessionId]?.[requestId];
    let optionId = response?.optionId;
    if (!optionId && offered) {
      optionId = selectApprovalOption(
        offered.options ?? offered.optionIds,
        response?.approved === true,
      );
      debug(
        `selected approval option (${optionId ? "matched" : "none"}; ${
          response?.approved === true ? "approve" : "deny"
        })`,
      );
    }
    if (typeof requestId !== "string" || typeof optionId !== "string") {
      debug("dropped invalid Happy permission response");
      return { ok: false };
    }
    const validation = validatePermissionResponse(sessionId, requestId, optionId, {
      liveSessions,
      pendingRequests,
    });
    if (!validation.ok) {
      debug("dropped invalid Happy permission response");
      return { ok: false };
    }
    await source.respondToPermission(sessionId, requestId, optionId);
    delete pendingRequests[sessionId]?.[requestId];
    return { ok: true };
  }

  async function createSessionEntry(sessionId, summary, existingSession = null) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    if (!api || !identity) throw new Error("Happy API is not registered");
    const machineId = identity.machineId ?? "seren-desktop";
    const session = existingSession ?? await api.getOrCreateSession({
      tag: `seren-${sessionId}`,
      metadata: sessionMetadata(config, summary, machineId),
      state: { controlledByUser: true },
    });
    if (!session) throw new Error("Happy relay did not return a session");
    const client = api.sessionSyncClient(session);
    const entry = { sessionId, happySessionId: session.id, summary, session, client };
    sessions.set(sessionId, entry);
    liveSessions.add(sessionId);
    rememberPendingPermissions(sessionId, summary?.pendingPermissions);
    registerInbound(entry);
    client.sendSessionEvent({ type: "switch", mode: "remote" });
    return entry;
  }

  async function findOrCreateSession(sessionId, summary = null) {
    if (terminatedSessions.has(sessionId)) return null;
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const inFlight = sessionCreationPromises.get(sessionId);
    if (inFlight) return inFlight;
    const creation = (async () => {
      const listed = summary ?? (await source.listSessions()).find((item) => item.sessionId === sessionId);
      return createSessionEntry(sessionId, listed ?? {
        sessionId,
        agentType: "claude-code",
        cwd: os.homedir(),
        status: "ready",
      });
    })();
    sessionCreationPromises.set(sessionId, creation);
    try {
      return await creation;
    } finally {
      sessionCreationPromises.delete(sessionId);
    }
  }

  async function publishEvent(event) {
    const terminal =
      event.kind === "status" && ["error", "terminated"].includes(event.payload?.status);
    if (terminal) {
      liveSessions.delete(event.sessionId);
      delete pendingRequests[event.sessionId];
      terminatedSessions.mark(event.sessionId);
    } else {
      liveSessions.add(event.sessionId);
      terminatedSessions.forget(event.sessionId);
    }
    rememberPermission(event);
    if (terminal && !sessions.has(event.sessionId)) return;
    const summary = (await source.listSessions()).find((item) => item.sessionId === event.sessionId);
    const entry = await findOrCreateSession(event.sessionId, summary);
    if (!entry) return;
    const provider = summary?.agentType === "claude-code" ? "claude" : summary?.agentType ?? "codex";
    for (const message of translateNeutralEvent(event, { provider })) {
      if (message.transport === "session") entry.client.sendSessionProtocolMessage(message.envelope);
      if (message.transport === "agent") entry.client.sendAgentMessage(message.provider, message.body);
    }
    if (terminal) {
      await completeTerminalSession({
        sessions,
        sessionId: event.sessionId,
        entry,
        send: async () => {},
      }).catch(() => debug("failed to close Happy session"));
    }
    if (event.kind === "permission-request" && api) {
      const notification = composeApprovalNotification();
      api.push().sendToAllDevices(notification.title, notification.body, notification.data);
    }
  }

  async function updateCapabilities() {
    if (!machineClient || !source) return;
    const advertised = await source.advertise();
    advertisedAgents = Array.isArray(advertised.agents) ? advertised.agents : [];
    await machineClient.updateMachineMetadata((metadata) => ({
      ...(metadata ?? machineMetadata(config)),
      remoteCapabilities: { agents: advertisedAgents, roots: advertisedRoots },
    }));
  }

  async function handleSpawn(options) {
    const validation = validateSpawnRoot(options?.directory, advertisedRoots);
    if (!validation.ok) {
      debug("refused spawn outside advertised roots");
      return { type: "error", errorMessage: "Requested directory is not an advertised root" };
    }
    const agentType = happyAgentType(options?.agent);
    const pendingSessionId = `spawn-${randomUUID()}`;
    const pending = await createSessionEntry(pendingSessionId, {
      sessionId: pendingSessionId,
      agentType,
      cwd: validation.root,
      title: `${agentType} Agent`,
      status: "initializing",
    });
    const conversation = await supervisorChannel.call("conversation_create", {
      agentType,
      cwd: validation.root,
      title: `${agentType} Agent`,
      happySessionId: pending.happySessionId,
    });
    const spawned = await source.spawn({
      agentType,
      cwd: validation.root,
      localSessionId: conversation.conversationId,
      approvalPolicy: defaultApprovalPolicy(agentType),
    });
    if (!spawned?.sessionId) throw new Error("provider spawn returned no session");
    sessions.delete(pendingSessionId);
    pending.sessionId = spawned.sessionId;
    pending.summary = spawned;
    sessions.set(spawned.sessionId, pending);
    liveSessions.delete(pendingSessionId);
    liveSessions.add(spawned.sessionId);
    pendingRequests[spawned.sessionId] = pendingRequests[pendingSessionId] ?? Object.create(null);
    delete pendingRequests[pendingSessionId];
    return { type: "success", sessionId: pending.happySessionId };
  }

  function setupMachineHandlers() {
    machineClient.setRPCHandlers({
      spawnSession: handleSpawn,
      stopSession: (sessionId) => {
        const entry = Array.from(sessions.values()).find(
          (candidate) => candidate.happySessionId === sessionId,
        );
        if (!entry) return false;
        void source.cancel(entry.sessionId).catch(() => debug("failed to cancel Happy session"));
        return true;
      },
      requestShutdown: () => debug("Happy client requested bridge shutdown"),
    });
  }

  async function registerMachine() {
    if (!identity) return false;
    const credentials = credentialsFromIdentity(identity);
    api = await ApiClient.create(credentials);
    const machineId = identity.machineId ?? randomUUID();
    if (!identity.machineId) {
      identity = { ...identity, machineId };
      await supervisorChannel.call("identity_store", { identity });
    }
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: machineMetadata(config),
      daemonState: { status: "running", pid: process.pid, startedAt: Date.now() },
    });
    machineClient = api.machineSyncClient(machine);
    setupMachineHandlers();
    machineClient.connect();
    return true;
  }

  async function waitForAuthorization(keyPair) {
    const deadline = Date.now() + AUTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await readAuthRequest(config.relayUrl, keyPair.publicKey);
      if (result.state === "authorized") {
        identity = identityFromAuthResponse(result.token, decryptAuthResponse(result.response, keyPair.secretKey));
        await supervisorChannel.call("identity_store", { identity });
        await registerMachine();
        supervisorSubscription = supervisorChannel.onNotification((method, params) => {
          if (method === "roots_update") {
            advertisedRoots = Array.isArray(params?.roots) ? params.roots : [];
            void updateCapabilities().catch(() => debug("failed to update Happy capabilities"));
          }
        });
        await finishRegistration();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS));
    }
    debug("pairing authorization timed out");
    return false;
  }

  async function startPairing() {
    if (pairingPromise) {
      if (latestPairingPayload) {
        supervisorChannel.notify("pairing_payload", { payload: latestPairingPayload });
      }
      return pairingPromise;
    }
    pairingPromise = (async () => {
      const keyPair = nacl.box.keyPair();
      await postAuthRequest(config.relayUrl, keyPair.publicKey);
      const payload = `happy://terminal?${encodeBase64Url(keyPair.publicKey)}`;
      latestPairingPayload = payload;
      supervisorChannel.notify("pairing_payload", { payload });
      void waitForAuthorization(keyPair)
        .then((authorized) => {
          if (!authorized) pairingPromise = null;
        })
        .catch((error) => {
          pairingPromise = null;
          debug(`pairing authorization failed: ${error instanceof Error ? error.message : "unknown error"}`);
        });
      return payload;
    })();
    return pairingPromise;
  }

  async function finishRegistration() {
    return startupStatusGate.complete(async () => {
      await updateCapabilities();
      const listed = await source.listSessions();
      for (const summary of listed) await createSessionEntry(summary.sessionId, summary);
      sourceSubscription?.();
      sourceSubscription = source.subscribe((event) => {
        void publishEvent(event).catch(() => debug("failed to publish Happy session event"));
      });
    });
  }

  return {
    async start() {
      supervisorSubscription = supervisorChannel.onNotification((method, params) => {
        if (method === "roots_update") {
          advertisedRoots = Array.isArray(params?.roots) ? params.roots : [];
          void updateCapabilities().catch(() => debug("failed to update Happy capabilities"));
        }
      });
      if (await registerMachine()) {
        await finishRegistration();
        return;
      }
      supervisorSubscription?.();
      supervisorSubscription = null;
      return startPairing();
    },
    startPairing,
    close() {
      sourceSubscription?.();
      supervisorSubscription?.();
      for (const entry of sessions.values()) {
        void entry.client.close().catch(() => debug("failed to close Happy session"));
      }
      sessions.clear();
      terminatedSessions.clear();
      machineClient?.shutdown();
      machineClient = null;
      api = null;
    },
  };
}

export async function completeTerminalSession({ sessions, sessionId, entry, send }) {
  await send(entry);
  sessions.delete(sessionId);
  await entry.client.close();
}
