// ABOUTME: Owns the narrow Happy client, session stream, and hosted-relay adapter.
// ABOUTME: Pairing material crosses the supervisor channel only and is never logged.

import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { ApiClient, configuration } from "happy/lib";
import nacl from "tweetnacl";

import { translateNeutralEvent, composeApprovalNotification } from "./translate.mjs";
import {
  isWithinAdvertisedRoots,
  validatePermissionResponse,
  validateSpawnRoot,
} from "./validate.mjs";

const AUTH_POLL_MS = 1000;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const SUMMARY_CACHE_TTL_MS = 1000;
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

function postPairingRequest(relayUrl, publicKey, signal) {
  const url = new URL(`${relayUrl.replace(/\/+$/, "")}/v1/auth/request`);
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) return Promise.reject(new Error("Happy relay must use HTTP or HTTPS"));
  const body = JSON.stringify({ publicKey: encodeBase64(publicKey), supportsV2: true });

  return new Promise((resolve, reject) => {
    let responseBody = "";
    let responseEnded = false;
    let responseStatus = 0;
    let failure = null;
    let aborted = false;
    const request = transport.request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          Connection: "close",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Happy-Client": "seren-desktop/phase-3",
        },
      },
      (response) => {
        responseStatus = response.statusCode ?? 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.once("aborted", () => {
          failure = new Error("Happy pairing response ended early");
        });
        response.once("error", (error) => {
          failure = error;
        });
        response.once("end", () => {
          responseEnded = true;
        });
      },
    );

    const onAbort = () => {
      aborted = true;
      const error = new Error("Happy pairing request aborted");
      error.name = "AbortError";
      request.destroy(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    request.once("error", (error) => {
      if (!aborted) failure = error;
    });
    // Resolve only after the request's own socket closes. The bridge exits as
    // soon as its cleanup promises settle, so response `end` is too early on
    // Windows: libuv may still be closing the underlying async handle.
    request.once("close", () => {
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        const error = new Error("Happy pairing request aborted");
        error.name = "AbortError";
        reject(error);
      } else if (failure) {
        reject(failure);
      } else if (!responseEnded) {
        reject(new Error("Happy pairing response ended early"));
      } else {
        resolve({ status: responseStatus, body: responseBody });
      }
    });

    if (signal?.aborted) onAbort();
    else request.end(body);
  });
}

async function postAuthRequest(relayUrl, publicKey) {
  const response = await postPairingRequest(relayUrl, publicKey);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Happy pairing request rejected (${response.status})`);
  }
}

async function readAuthRequest(relayUrl, publicKey, signal) {
  const response = await postPairingRequest(relayUrl, publicKey, signal);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Happy pairing status rejected (${response.status})`);
  }
  return JSON.parse(response.body);
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

// The remote peer names the agent, and the value is persisted as a conversation
// row before the provider runtime ever validates it. Resolve to a known agent or
// refuse, so an arbitrary remote string cannot reach the database.
const HAPPY_AGENT_TYPES = new Map([
  ["claude", "claude-code"],
  ["claude-code", "claude-code"],
  ["gemini", "gemini"],
  ["grok", "grok"],
  ["codex", "codex"],
]);

function happyAgentType(agent) {
  if (agent === undefined || agent === null) return "claude-code";
  return HAPPY_AGENT_TYPES.get(agent) ?? null;
}

function defaultApprovalPolicy(agentType) {
  // Match the desktop's fresh-session defaults. Codex is explicitly
  // on-failure; Claude, Gemini, and Grok resolve their normal defaults in their
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

// Modes the provider runtimes accept. A remote peer may only move a session
// between these; anything else is rejected at the bridge boundary rather than
// coerced, because codex maps unknown modes to its permissive "auto".
const SUPPORTED_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "read-only",
  "safe-yolo",
  "yolo",
  "ask",
  "auto",
]);

export function isSupportedPermissionMode(mode) {
  return typeof mode === "string" && SUPPORTED_PERMISSION_MODES.has(mode);
}

// An already-tracked entry wins over the terminated mark, so a terminal event
// can still flush its envelopes and close the relay client. The mark only blocks
// *creating* a new entry for a session that has already ended.
export function resolveTrackedSession({ sessions, terminatedSessions, sessionId }) {
  const entry = sessions.get(sessionId);
  if (entry) return { entry, blocked: false };
  return { entry: null, blocked: terminatedSessions.has(sessionId) };
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

function isUsableHappySession(session) {
  return (
    session !== null &&
    typeof session === "object" &&
    typeof session.metadata?.path === "string" &&
    session.metadata.path.length > 0
  );
}

export async function getOrCreateUsableHappySession({
  api,
  tag,
  metadata,
  state,
  debugLog = () => {},
  replacementTag = () => `seren-recovery-${randomUUID()}`,
}) {
  const initial = await api.getOrCreateSession({ tag, metadata, state });
  if (!initial || isUsableHappySession(initial)) return initial ?? null;

  // Data-key sessions cannot decrypt a relay record created by an earlier
  // bridge process because Happy 1.2.0 keeps that session key only in memory.
  // A one-time tag forces a fresh encrypted record instead of passing null
  // metadata into ApiSessionClient, whose constructor dereferences `.path`.
  debugLog("replacing Happy session with unreadable metadata");
  const replacement = await api.getOrCreateSession({
    tag: replacementTag(),
    metadata,
    state,
  });
  return isUsableHappySession(replacement) ? replacement : null;
}

export function createHappyLayer({
  config,
  supervisorChannel,
  source,
  debugLog = () => {},
  onShutdownRequest = async () => {},
}) {
  configuration.serverUrl = config.relayUrl;
  let identity = config.machineIdentity;
  let api = null;
  let machineClient = null;
  let pairingPromise = null;
  let pairingAuthorizationPromise = null;
  let pairingAbortController = null;
  let latestPairingPayload = null;
  let pairingCancelled = false;
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

  const sessionSummaries = new Map();
  let summariesFetchedAt = 0;

  function debug(message) {
    debugLog(message);
  }

  // Listing every session once per streamed event issued one provider RPC per
  // assistant delta. Summaries are stable for the fields consumed here
  // (agentType, cwd), so they are cached and only re-listed for a session the
  // cache has never seen, at most once per interval.
  async function refreshSessionSummaries() {
    const listed = await source.listSessions();
    sessionSummaries.clear();
    for (const summary of listed) sessionSummaries.set(summary.sessionId, summary);
    summariesFetchedAt = Date.now();
    return listed;
  }

  async function sessionSummary(sessionId) {
    if (
      !sessionSummaries.has(sessionId) &&
      Date.now() - summariesFetchedAt > SUMMARY_CACHE_TTL_MS
    ) {
      await refreshSessionSummaries();
    }
    return sessionSummaries.get(sessionId) ?? null;
  }

  // A paired device may only observe and drive sessions in folders the user
  // shared. Spawning still requires the path to *be* an advertised root; an
  // already-running session inside one is in scope.
  function isSessionInScope(summary) {
    return isWithinAdvertisedRoots(summary?.cwd, advertisedRoots);
  }

  // Called whenever the advertised roots change so sessions that fall out of
  // scope stop being observable rather than lingering until restart.
  async function dropSessionsOutOfScope() {
    for (const [sessionId, entry] of Array.from(sessions.entries())) {
      if (isSessionInScope(entry.summary)) continue;
      sessions.delete(sessionId);
      liveSessions.delete(sessionId);
      delete pendingRequests[sessionId];
      sessionCreationPromises.delete(sessionId);
      await entry.client
        .close()
        .catch(() => debug("failed to close Happy session leaving scope"));
    }
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
    // Decryption failure yields null params rather than throwing, and these two
    // handlers ignore their argument, so without this guard a relay could cancel
    // a live turn with ciphertext it cannot even produce. A legitimate empty
    // payload decrypts to {}, so null is unambiguously a failed decrypt.
    const cancelSession = (label) => async (params) => {
      if (params === null) {
        debug(`dropped unauthenticated Happy ${label} request`);
        return { ok: false };
      }
      try {
        await source.cancel(entry.sessionId);
        return { ok: true };
      } catch {
        debug(`ignored failed Happy ${label} request`);
        return { ok: false };
      }
    };
    client.rpcHandlerManager.registerHandler("abort", cancelSession("abort"));
    client.rpcHandlerManager.registerHandler("switch", cancelSession("switch"));
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
    if (message.meta && mode !== undefined && !isSupportedPermissionMode(mode)) {
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
    const metadata = sessionMetadata(config, summary, machineId);
    const session =
      existingSession ??
      (await getOrCreateUsableHappySession({
        api,
        tag: `seren-${sessionId}`,
        metadata,
        state: { controlledByUser: true },
        debugLog: debug,
      }));
    if (!isUsableHappySession(session)) {
      throw new Error("Happy relay did not return a usable session");
    }
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
    const tracked = resolveTrackedSession({ sessions, terminatedSessions, sessionId });
    if (tracked.entry) return tracked.entry;
    if (tracked.blocked) return null;
    const inFlight = sessionCreationPromises.get(sessionId);
    if (inFlight) return inFlight;
    const creation = (async () => {
      const listed = summary ?? (await sessionSummary(sessionId));
      // The previous fallback invented a summary rooted at the home directory,
      // which is not a folder the user shared. A session the provider runtime
      // cannot describe stays out of scope rather than being exposed.
      if (!listed || !isSessionInScope(listed)) {
        debug("skipped Happy session outside advertised roots");
        return null;
      }
      return createSessionEntry(sessionId, listed);
    })();
    sessionCreationPromises.set(sessionId, creation);
    try {
      return await creation;
    } finally {
      sessionCreationPromises.delete(sessionId);
    }
  }

  async function publishEvent(event) {
    // An entry only exists if it passed the scope check when it was created, so
    // a tracked session stays tracked; an unknown one is gated here, before any
    // bookkeeping, so out-of-scope sessions accumulate no state either.
    const summary =
      (await sessionSummary(event.sessionId)) ?? sessions.get(event.sessionId)?.summary ?? null;
    if (!sessions.has(event.sessionId) && !isSessionInScope(summary)) {
      debug("dropped event for session outside advertised roots");
      return;
    }
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
    if (!agentType) {
      debug("refused spawn for unknown agent type");
      return { type: "error", errorMessage: "Requested agent is not available" };
    }
    const pendingSessionId = `spawn-${randomUUID()}`;
    const pending = await createSessionEntry(pendingSessionId, {
      sessionId: pendingSessionId,
      agentType,
      cwd: validation.root,
      title: `${agentType} Agent`,
      status: "initializing",
    });
    // Everything past this point can reject, and the pending entry already holds
    // an open sync client and a relay-side session. Unwind it on failure so a
    // repeated failing spawn cannot accumulate open sockets.
    try {
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
      // Seed the cache so the first streamed event resolves this session's
      // provider without re-listing.
      sessionSummaries.set(spawned.sessionId, spawned);
      return { type: "success", sessionId: pending.happySessionId };
    } catch (error) {
      await discardPendingSpawn(pendingSessionId, pending);
      debug("failed to spawn Happy session");
      return {
        type: "error",
        errorMessage: error instanceof Error ? error.message : "spawn failed",
      };
    }
  }

  // Registered from both the freshly-paired and already-paired startup paths.
  // A single listener keeps `dispatchNotification`'s queueing behaviour intact —
  // it stops queueing as soon as any listener exists, so adding a second one
  // elsewhere would drop notifications this one is waiting for.
  function subscribeToSupervisor() {
    supervisorSubscription = supervisorChannel.onNotification((method, params) => {
      if (method === "roots_update") {
        advertisedRoots = Array.isArray(params?.roots) ? params.roots : [];
        void (async () => {
          await dropSessionsOutOfScope();
          await updateCapabilities();
        })().catch(() => debug("failed to apply Happy roots update"));
        return;
      }
      if (method === "cancel_pairing") {
        cancelPairing();
        return;
      }
      if (method === "shutdown") {
        // Windows has no SIGTERM, so a graceful stop has to arrive over the
        // channel that already exists. Handled inside this listener rather than
        // a second one, which would defeat `dispatchNotification`'s queueing.
        void onShutdownRequest().catch(() => debug("failed to handle shutdown request"));
      }
    });
  }

  async function discardPendingSpawn(pendingSessionId, pending) {
    sessions.delete(pendingSessionId);
    liveSessions.delete(pendingSessionId);
    delete pendingRequests[pendingSessionId];
    sessionCreationPromises.delete(pendingSessionId);
    await pending.client.close().catch(() => debug("failed to close abandoned Happy session"));
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

  async function waitForAuthorization(keyPair, signal) {
    const deadline = Date.now() + AUTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (pairingCancelled) {
        debug("pairing abandoned before authorization");
        return false;
      }
      const result = await readAuthRequest(config.relayUrl, keyPair.publicKey, signal);
      // Checked again after the round trip: an authorization that lands while
      // the user is dismissing the dialog must not be accepted.
      if (pairingCancelled) {
        debug("pairing abandoned before authorization");
        return false;
      }
      if (result.state === "authorized") {
        identity = identityFromAuthResponse(result.token, decryptAuthResponse(result.response, keyPair.secretKey));
        await supervisorChannel.call("identity_store", { identity });
        await registerMachine();
        supervisorSubscription = subscribeToSupervisor();
        await finishRegistration();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS));
    }
    debug("pairing authorization timed out");
    return false;
  }

  // Abandons an in-flight pairing wait. Without this, dismissing the QR dialog
  // left `waitForAuthorization` polling for the full timeout and still
  // accepting whoever scanned the code in the meantime.
  function cancelPairing() {
    if (!pairingPromise && !latestPairingPayload) return;
    pairingCancelled = true;
    pairingAbortController?.abort();
    pairingPromise = null;
    latestPairingPayload = null;
    debug("pairing cancelled by supervisor");
  }

  async function startPairing() {
    pairingCancelled = false;
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
      const abortController = new AbortController();
      pairingAbortController = abortController;
      pairingAuthorizationPromise = waitForAuthorization(keyPair, abortController.signal)
        .then((authorized) => {
          if (!authorized) pairingPromise = null;
        })
        .catch((error) => {
          pairingPromise = null;
          if (error?.name !== "AbortError") {
            debug(`pairing authorization failed: ${error instanceof Error ? error.message : "unknown error"}`);
          }
        })
        .finally(() => {
          if (pairingAbortController === abortController) {
            pairingAbortController = null;
            pairingAuthorizationPromise = null;
          }
        });
      void pairingAuthorizationPromise;
      return payload;
    })();
    return pairingPromise;
  }

  async function finishRegistration() {
    return startupStatusGate.complete(async () => {
      await updateCapabilities();
      const listed = await refreshSessionSummaries();
      for (const summary of listed) {
        if (!isSessionInScope(summary)) continue;
        await createSessionEntry(summary.sessionId, summary);
      }
      sourceSubscription?.();
      sourceSubscription = source.subscribe((event) => {
        void publishEvent(event).catch(() => debug("failed to publish Happy session event"));
      });
    });
  }

  return {
    async start() {
      supervisorSubscription = subscribeToSupervisor();
      if (await registerMachine()) {
        await finishRegistration();
        return;
      }
      supervisorSubscription?.();
      supervisorSubscription = null;
      return startPairing();
    },
    startPairing,
    async close() {
      sourceSubscription?.();
      supervisorSubscription?.();
      cancelPairing();
      await pairingAuthorizationPromise;
      // Awaited rather than fire-and-forget: the caller exits the process once
      // this resolves, and tearing the event loop down while these closes are
      // still in flight aborts the process on Windows.
      await Promise.allSettled(
        [...sessions.values()].map((entry) =>
          entry.client.close().catch(() => debug("failed to close Happy session")),
        ),
      );
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
