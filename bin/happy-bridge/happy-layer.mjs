// ABOUTME: Owns the narrow Happy client, session stream, and hosted-relay adapter.
// ABOUTME: Pairing material crosses the supervisor channel only and is never logged.

import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { ApiClient, configuration } from "happy/lib";
import nacl from "tweetnacl";

import {
  composeApprovalNotification,
  createAssistantMessageCoalescer,
  createTurnCorrelator,
  translateNeutralEvent,
} from "./translate.mjs";
import {
  isWithinAdvertisedRoots,
  validatePermissionResponse,
  validateSpawnRoot,
} from "./validate.mjs";
import { createHappySessionKeyStore } from "./session-key-store.mjs";

const AUTH_POLL_MS = 1000;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_KEEP_ALIVE_MS = 2000;
const DEFAULT_CODEX_APPROVAL_POLICY = "on-failure";
const HAPPY_CONTEXT_RESET_NOTICE =
  "Provider context reset: the original native session was unavailable, so Seren started a new provider context for this existing Happy thread.";
const BUSY_SESSION_STATUSES = new Set(["prompting", "busy", "running"]);
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function isRetryableAuthPollError(error) {
  return error && typeof error === "object" && error.code === "ECONNRESET";
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
const RESTORABLE_HAPPY_AGENT_TYPES = new Set(HAPPY_AGENT_TYPES.values());
const EXACT_RESUME_HAPPY_AGENT_TYPES = new Set(["claude-code", "codex"]);

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

function createSessionLiveness(client, initialThinking = false) {
  let thinking = initialThinking;
  let stopped = false;
  const pulse = () => {
    if (!stopped) client.keepAlive(thinking, "remote");
  };
  pulse();
  const interval = setInterval(pulse, SESSION_KEEP_ALIVE_MS);

  return {
    setThinking(value) {
      if (stopped || thinking === value) return;
      thinking = value;
      pulse();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
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

// Matched on shape rather than the exact sentence. Runtimes name the session
// in their own words — LM Studio says "...for this LM Studio session." — and an
// exact compare silently discarded the queued prompt for those sessions. #3145
export function isPromptBusyError(error) {
  return (
    error instanceof Error &&
    /^Another prompt is already active for this .*session\.$/.test(
      error.message,
    )
  );
}

export function createDeferredPromptQueue({
  send,
  onError = () => {},
  shouldRetry = () => false,
  maxQueuedPerSession = 32,
}) {
  const queues = new Map();
  const busySessions = new Set();
  const drainingSessions = new Set();
  const readyDuringSubmission = new Set();
  const cancelledSessions = new Set();
  const failedSessions = new Set();
  const drainOperations = new Set();
  let closed = false;

  async function drain(sessionId) {
    if (
      closed ||
      failedSessions.has(sessionId) ||
      busySessions.has(sessionId) ||
      drainingSessions.has(sessionId)
    ) {
      return;
    }
    const queue = queues.get(sessionId);
    if (!queue?.length) return;

    drainingSessions.add(sessionId);
    busySessions.add(sessionId);
    try {
      // Submit exactly one head item. Acceptance only means the provider owns
      // this prompt; the next relay record must wait for an explicit ready,
      // error, or turn-complete event from that provider.
      const item = queue[0];
      try {
        const outcome = await send(sessionId, item.value);
        if (queue[0] === item) queue.shift();
        item.resolve(!cancelledSessions.has(sessionId));
        // Provider events and RPC responses use independent frames. Preserve an
        // authoritative completion that overtakes the acceptance response;
        // configuration-only status events are filtered by publishEvent.
        const providerBecameReady = readyDuringSubmission.delete(sessionId);
        if (outcome?.terminalDiscard === true || providerBecameReady) {
          busySessions.delete(sessionId);
        }
      } catch (error) {
        if (shouldRetry(error)) {
          onError(error, { deferred: true, sessionId });
          if (readyDuringSubmission.delete(sessionId)) {
            busySessions.delete(sessionId);
          }
        } else {
          if (queue[0] === item) queue.shift();
          item.reject(error);
          failedSessions.add(sessionId);
          onError(error, { deferred: false, sessionId });
        }
      }
    } finally {
      drainingSessions.delete(sessionId);
      if (queue.length === 0 || cancelledSessions.has(sessionId)) {
        queues.delete(sessionId);
        if (cancelledSessions.delete(sessionId)) failedSessions.delete(sessionId);
      } else if (!closed && !busySessions.has(sessionId)) {
        void startDrain(sessionId);
      }
    }
  }

  function startDrain(sessionId) {
    const operation = drain(sessionId);
    drainOperations.add(operation);
    void operation.then(
      () => drainOperations.delete(operation),
      () => drainOperations.delete(operation),
    );
    return operation;
  }

  function clear(sessionId) {
    const queue = queues.get(sessionId) ?? [];
    busySessions.delete(sessionId);
    readyDuringSubmission.delete(sessionId);
    if (drainingSessions.has(sessionId)) {
      cancelledSessions.add(sessionId);
      for (const item of queue.splice(1)) item.resolve(false);
      return;
    }
    queues.delete(sessionId);
    cancelledSessions.delete(sessionId);
    failedSessions.delete(sessionId);
    for (const item of queue.splice(0)) item.resolve(false);
  }

  return {
    enqueue(sessionId, value) {
      if (closed) return Promise.resolve(false);
      if (failedSessions.has(sessionId)) return Promise.resolve(false);
      const queue = queues.get(sessionId) ?? [];
      // A paired peer must not be able to grow memory without bound while a
      // long local turn is active. Preserve the oldest accepted prompts.
      if (queue.length >= maxQueuedPerSession) {
        onError(new Error("Happy prompt queue is full"), {
          deferred: false,
          sessionId,
        });
        return Promise.resolve(false);
      }
      queues.set(sessionId, queue);
      const result = new Promise((resolve, reject) =>
        queue.push({ value, resolve, reject }),
      );
      void startDrain(sessionId);
      return result;
    },
    setBusy(sessionId, busy) {
      if (busy) {
        busySessions.add(sessionId);
        readyDuringSubmission.delete(sessionId);
        return;
      }
      if (failedSessions.has(sessionId)) return;
      if (drainingSessions.has(sessionId)) {
        readyDuringSubmission.add(sessionId);
        return;
      }
      busySessions.delete(sessionId);
      void startDrain(sessionId);
    },
    clear,
    async close() {
      closed = true;
      await Promise.allSettled([...drainOperations]);
      for (const sessionId of Array.from(queues.keys())) clear(sessionId);
      busySessions.clear();
      readyDuringSubmission.clear();
      cancelledSessions.clear();
      failedSessions.clear();
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
  encryptionKey,
  expectedSessionId,
  allowLegacyReplacement = false,
  debugLog = () => {},
  replacementTag,
  persistReplacementTag = async () => {},
  persistReady = async () => {},
}) {
  const options = encryptionKey ? { tag, metadata, state, encryptionKey } : { tag, metadata, state };
  const initial = await api.getOrCreateSession(options);
  if (!initial) return null;
  if (isUsableHappySession(initial)) {
    if (expectedSessionId && initial.id !== expectedSessionId) {
      debugLog("Happy session binding resolved to a different relay row");
      if (!(await api.deactivateSession(initial.id))) {
        debugLog("failed to retire unexpected Happy relay row");
      }
      return null;
    }
    try {
      await persistReady(initial.id);
    } catch (error) {
      if (!(await api.deactivateSession(initial.id))) {
        debugLog("failed to retire Happy relay row after persistence failure");
      }
      throw error;
    }
    return initial;
  }

  // Older data-key bridge builds generated an in-memory random key for this
  // stable tag. Only a new pending binding may migrate it: a ready binding that
  // becomes unreadable is corruption and must fail closed rather than fork.
  if (!allowLegacyReplacement || typeof initial.id !== "string") return null;
  debugLog("retiring Happy session with unreadable metadata");
  if (!(await api.deactivateSession(initial.id))) {
    debugLog("failed to retire Happy session with unreadable metadata");
    return null;
  }
  if (typeof replacementTag !== "string" || replacementTag.length === 0) return null;
  // Persist the recovery tag before its POST. If the process exits after the
  // relay creates the row, the next process retries the same tag and key.
  await persistReplacementTag(replacementTag);
  const replacement = await api.getOrCreateSession({
    ...options,
    tag: replacementTag,
    metadata,
    state,
  });
  if (!isUsableHappySession(replacement)) return null;
  try {
    await persistReady(replacement.id);
  } catch (error) {
    if (!(await api.deactivateSession(replacement.id))) {
      debugLog("failed to retire replacement Happy row after persistence failure");
    }
    throw error;
  }
  return replacement;
}

export function disposeHappySessionEntry({ api, entry, debugLog = () => {} }) {
  if (entry.disposal) return entry.disposal;
  entry.liveness?.stop();
  entry.disposal = (async () => {
    try {
      entry.client.sendSessionDeath();
    } catch {
      debugLog("failed to signal Happy session end");
    }
    const deactivate = (async () => {
      try {
        const retired = await api.deactivateSession(entry.happySessionId);
        if (!retired) {
          debugLog("failed to deactivate Happy session");
        }
        return retired;
      } catch {
        debugLog("failed to deactivate Happy session");
        return false;
      }
    })();
    // The HTTP fallback and outbox/socket close are independent. Starting both
    // keeps worst-case teardown within the supervisor's bounded grace period.
    const [deactivateResult, closeResult] = await Promise.allSettled([
      deactivate,
      entry.client.close(),
    ]);
    if (closeResult.status === "rejected") debugLog("failed to close Happy session client");
    return deactivateResult.status === "fulfilled" && deactivateResult.value;
  })();
  return entry.disposal;
}

export function createHappyLayer({
  config,
  supervisorChannel,
  source,
  debugLog = () => {},
  onShutdownRequest = async () => {},
  sessionKeyStore: providedSessionKeyStore = null,
}) {
  configuration.serverUrl = config.relayUrl;
  let identity = config.machineIdentity;
  let api = null;
  let sessionKeyStore = null;
  let machineClient = null;
  let pairingPromise = null;
  let pairingAuthorizationPromise = null;
  let pairingAbortController = null;
  let latestPairingPayload = null;
  let pairingCancelled = false;
  let closing = false;
  let identityResetting = false;
  let identityResetPromise = null;
  let sourceSubscription = null;
  let supervisorSubscription = null;
  let advertisedRoots = [];
  let advertisedAgents = [];
  const startupStatusGate = createStartupStatusGate((status) => {
    supervisorChannel.notify("status_report", status);
  });
  const sessions = new Map();
  const sessionCreationPromises = new Map();
  const sessionDisposals = new Set();
  const spawnOperations = new Set();
  const layerOperations = new Set();
  const remotelyArchivedSessions = new Set();
  const ownershipPendingSessions = new Set();
  const ownershipPendingProviderStatuses = new Map();
  const terminatedSessions = createTerminatedSessionTracker();
  const pendingRequests = Object.create(null);
  const liveSessions = new Set();
  const turnCorrelator = createTurnCorrelator();
  const assistantMessageCoalescer = createAssistantMessageCoalescer();

  const sessionSummaries = new Map();
  const sessionSummaryRevisions = new Map();
  let sessionSummaryRevision = 0;
  let summariesRefreshPromise = null;

  function debug(message) {
    debugLog(message);
  }

  function initializeSessionKeyStore() {
    const storeKey =
      identity?.encryption?.type === "dataKey"
        ? identity.encryption.machineKey
        : identity?.encryption?.type === "legacy"
          ? identity.encryption.secret
          : identity?.secret;
    if (!storeKey) {
      sessionKeyStore = null;
      return;
    }
    if (providedSessionKeyStore) {
      sessionKeyStore = providedSessionKeyStore;
      return;
    }
    const directory = process.env.HAPPY_HOME_DIR;
    if (typeof directory !== "string" || directory.length === 0) {
      throw new Error("Happy session key storage directory is unavailable");
    }
    sessionKeyStore = createHappySessionKeyStore({
      directory,
      machineKey: decodeByteValue(storeKey),
    });
  }

  async function forgetSessionBinding(sessionId) {
    if (!sessionKeyStore) return;
    try {
      await sessionKeyStore.delete(sessionId);
    } catch {
      debug("failed to remove Happy session binding");
    }
  }

  async function persistedSessionBindings() {
    if (!sessionKeyStore) return [];
    return sessionKeyStore.list();
  }

  async function persistedSessionBinding(sessionId) {
    const bindings = await persistedSessionBindings();
    return bindings.find((binding) => binding.sessionId === sessionId) ?? null;
  }

  async function providerSessionIsArchived(sessionId) {
    const result = await supervisorChannel.call("provider_session_archive_lookup", {
      providerSessionId: sessionId,
    });
    return result?.archived === true;
  }

  async function markSessionBindingRetiring(
    sessionId,
    happySessionId,
    providerRetired = false,
    blockRevival = false,
    conversationId,
    agentSessionId,
  ) {
    if (!sessionKeyStore) return null;
    try {
      return await sessionKeyStore.markRetiring(
        sessionId,
        happySessionId,
        providerRetired,
        blockRevival,
        conversationId,
        agentSessionId,
      );
    } catch {
      debug("failed to persist retiring Happy session binding");
      return null;
    }
  }

  async function resolveRetiringRelayId(sessionId, binding) {
    if (typeof binding?.happySessionId === "string") return binding.happySessionId;
    if (!api || !binding) return null;
    let session;
    try {
      session = await api.getOrCreateSession({
        tag: binding.relayTag,
        metadata: {
          path: os.homedir(),
          host: config.machineName,
          name: "Retiring Seren session",
          lifecycleState: "archived",
        },
        state: { controlledByUser: true },
        encryptionKey: binding.key,
      });
    } catch {
      debug("failed to resolve retiring Happy session binding");
      return null;
    }
    if (typeof session?.id !== "string" || session.id.length === 0) return null;
    const persisted = await markSessionBindingRetiring(sessionId, session.id);
    return persisted ? session.id : null;
  }

  async function retirePersistedSession({
    sessionId,
    binding,
    entry = null,
    terminateProvider = false,
    providerAlreadyRetired = false,
    blockRevival = false,
    desktopAlreadyFenced = false,
    agentSessionId,
    conversationId: knownConversationId,
  }) {
    let retiringBinding = binding;
    const shouldArchiveConversation = blockRevival || binding?.blockRevival === true;
    let conversationId = knownConversationId ?? binding?.conversationId;
    let archiveProviderOnly = false;
    const ownerAgentSessionId =
      agentSessionId ?? entry?.summary?.agentSessionId ?? binding?.agentSessionId;
    if (sessionKeyStore) {
      // Persist the user's archive intent before either the owner lookup or an
      // external teardown. A crash or transient DB failure can then resume the
      // whole retirement on the next bridge start.
      retiringBinding = await markSessionBindingRetiring(
        sessionId,
        entry?.happySessionId ?? binding?.happySessionId,
        providerAlreadyRetired || binding?.providerRetired === true,
        shouldArchiveConversation,
        conversationId,
        ownerAgentSessionId,
      );
      if (!retiringBinding) return false;
    }
    if (
      shouldArchiveConversation &&
      !desktopAlreadyFenced &&
      typeof conversationId !== "string"
    ) {
      try {
        const owner = await supervisorChannel.call("conversation_owner_lookup", {
          providerSessionId: sessionId,
          agentSessionId: ownerAgentSessionId ?? null,
        });
        if (typeof owner?.conversationId === "string" && owner.conversationId.length > 0) {
          conversationId = owner.conversationId;
        } else if (
          owner &&
          typeof owner === "object" &&
          !("conversationId" in owner)
        ) {
          // Predictive standbys and not-yet-persisted remote spawns have no
          // desktop conversation row. The supervisor still fences the exact
          // provider session in the frontend before it is terminated.
          archiveProviderOnly = true;
        } else {
          debug("failed to resolve desktop conversation for retired Happy session");
          return false;
        }
      } catch {
        debug("failed to resolve desktop conversation for retired Happy session");
        return false;
      }
      if (sessionKeyStore && !archiveProviderOnly) {
        // Persist the resolved owner before SQLite is changed. This exact id is
        // required after provider-session compaction and on a crash retry.
        retiringBinding = await markSessionBindingRetiring(
          sessionId,
          entry?.happySessionId ?? retiringBinding?.happySessionId,
          retiringBinding?.providerRetired === true,
          true,
          conversationId,
          ownerAgentSessionId,
        );
        if (!retiringBinding) return false;
      }
    }

    let providerRetired =
      providerAlreadyRetired || retiringBinding?.providerRetired === true;
    if (shouldArchiveConversation && !desktopAlreadyFenced) {
      try {
        if (archiveProviderOnly) {
          await supervisorChannel.call("provider_session_archive", {
            providerSessionId: sessionId,
          });
        } else {
          await supervisorChannel.call("conversation_archive", {
            conversationId,
            providerSessionId: sessionId,
          });
        }
      } catch {
        debug("failed to fence desktop state for retired Happy session");
        return false;
      }
    }
    if (terminateProvider) {
      try {
        await source.terminate(sessionId);
        providerRetired = true;
        if (sessionKeyStore) {
          retiringBinding = await markSessionBindingRetiring(
            sessionId,
            entry?.happySessionId ?? retiringBinding?.happySessionId,
            true,
            shouldArchiveConversation,
            conversationId,
            ownerAgentSessionId,
          );
          if (!retiringBinding) return false;
        }
      } catch {
        debug("failed to terminate provider for retiring Happy session");
      }
    }

    let relayRetired = false;
    if (entry) {
      relayRetired = await disposeHappySessionEntry({ api, entry, debugLog: debug });
    } else {
      const happySessionId = await resolveRetiringRelayId(sessionId, retiringBinding);
      if (happySessionId) {
        try {
          relayRetired = await api.deactivateSession(happySessionId);
        } catch {
          relayRetired = false;
        }
        if (!relayRetired) debug("failed to deactivate persisted Happy session");
      }
    }

    if (providerRetired && relayRetired) {
      await forgetSessionBinding(sessionId);
      if (shouldArchiveConversation) {
        remotelyArchivedSessions.add(sessionId);
      }
      return true;
    }
    return false;
  }

  async function retireProviderSessionFromDesktop(sessionId) {
    remotelyArchivedSessions.add(sessionId);
    terminatedSessions.mark(sessionId);
    const entry = sessions.get(sessionId) ?? null;
    if (entry) {
      sessions.delete(sessionId);
      liveSessions.delete(sessionId);
      promptQueue.clear(sessionId);
      turnCorrelator.clear(sessionId);
      assistantMessageCoalescer.clear(sessionId);
      delete pendingRequests[sessionId];
      sessionCreationPromises.delete(sessionId);
      entry.liveness.stop();
    }
    const binding = entry ? null : await persistedSessionBinding(sessionId);
    if (!entry && !binding) {
      await source
        .terminate(sessionId)
        .catch(() => debug("failed to terminate provider without a Happy binding"));
      return;
    }
    await retirePersistedSession({
      sessionId,
      ...(entry ? { entry } : { binding }),
      terminateProvider: true,
      blockRevival: true,
      desktopAlreadyFenced: true,
      agentSessionId: entry?.summary?.agentSessionId ?? binding?.agentSessionId,
    });
  }

  async function reconcilePersistedSessions(listed) {
    const bindings = await persistedSessionBindings();
    const listedIds = new Set(listed.map((summary) => summary.sessionId));
    const blocked = new Set();
    const archivedIds = new Set(
      (
        await Promise.all(
          bindings.map(async (binding) =>
            (await providerSessionIsArchived(binding.sessionId)) ? binding.sessionId : null,
          ),
        )
      ).filter(Boolean),
    );
    const retirements = bindings
      // Provider restoration happens after the bridge starts during a full app
      // launch, so absence from this first snapshot is not proof of termination.
      // Only an intent durably recorded before teardown is safe to replay.
      .filter((binding) => binding.state === "retiring" || archivedIds.has(binding.sessionId))
      .map(async (binding) => {
        blocked.add(binding.sessionId);
        const desktopAlreadyFenced = archivedIds.has(binding.sessionId);
        const retired = await retirePersistedSession({
          sessionId: binding.sessionId,
          binding,
          terminateProvider: listedIds.has(binding.sessionId),
          providerAlreadyRetired:
            (binding.blockRevival === true || desktopAlreadyFenced) &&
            !listedIds.has(binding.sessionId),
          blockRevival: desktopAlreadyFenced,
          desktopAlreadyFenced,
        });
        if (!retired) {
          throw new Error("Persisted Happy session retirement did not complete");
        }
        terminatedSessions.mark(binding.sessionId);
      });
    await Promise.all(retirements);
    return blocked;
  }

  async function migrateLegacyHappyProviderBindings(blockedSessionIds) {
    if (!sessionKeyStore || !api || !identity) return;
    const response = await supervisorChannel.call("conversation_restore_candidates", {});
    if (!Array.isArray(response?.candidates)) {
      throw new Error("Happy conversation migration returned an invalid candidate list");
    }
    const bindingsBySessionId = new Map(
      (await persistedSessionBindings()).map((binding) => [binding.sessionId, binding]),
    );
    const machineId = identity.machineId ?? "seren-desktop";

    for (const candidate of response.candidates) {
      const sessionId = candidate?.conversationId;
      const legacyHappySessionId = candidate?.happySessionId;
      if (
        typeof sessionId !== "string" ||
        !UUID_PATTERN.test(sessionId) ||
        typeof legacyHappySessionId !== "string" ||
        legacyHappySessionId.length === 0 ||
        blockedSessionIds.has(sessionId)
      ) {
        continue;
      }
      if (
        typeof candidate.agentType !== "string" ||
        !RESTORABLE_HAPPY_AGENT_TYPES.has(candidate.agentType) ||
        typeof candidate.cwd !== "string"
      ) {
        throw new Error("Happy conversation migration candidate was invalid");
      }
      const root = validateSpawnRoot(candidate.cwd, advertisedRoots);
      if (!root.ok || root.root !== candidate.cwd) {
        throw new Error("Happy conversation migration root was no longer authorized");
      }

      let binding = bindingsBySessionId.get(sessionId) ?? null;
      if (
        binding?.state === "ready" &&
        binding.happySessionId === legacyHappySessionId
      ) {
        // Rows created before the lifecycle fence existed can already have a
        // valid encrypted binding. Acknowledge that exact pair in SQLite
        // before provider notifications are subscribed so a later natural
        // termination (which deletes the key binding) cannot be mistaken for
        // another v3.72 migration candidate and resurrected.
        await supervisorChannel.call("conversation_migrate_happy_session", {
          conversationId: sessionId,
          expectedHappySessionId: legacyHappySessionId,
          replacementHappySessionId: legacyHappySessionId,
        });
        if (binding.legacyRelayRetired === true) {
          binding = await sessionKeyStore.clearLegacyRelayRetired(sessionId);
          bindingsBySessionId.set(sessionId, binding);
        }
        continue;
      }
      if (!binding) {
        binding = await sessionKeyStore.getOrCreate(
          sessionId,
          `seren-migrated-${randomUUID()}`,
        );
        bindingsBySessionId.set(sessionId, binding);
      }
      if (binding.state === "retiring") continue;

      if (
        binding.state === "ready" &&
        binding.happySessionId !== legacyHappySessionId &&
        binding.legacyRelayRetired !== true
      ) {
        const retired = await api.deactivateSession(legacyHappySessionId);
        if (!retired) {
          throw new Error("Legacy Happy relay row could not be retired");
        }
        binding = await sessionKeyStore.markLegacyRelayRetired(sessionId);
        bindingsBySessionId.set(sessionId, binding);
      }

      if (binding.state === "pending") {
        if (binding.legacyRelayRetired !== true) {
          const retired = await api.deactivateSession(legacyHappySessionId);
          if (!retired) {
            throw new Error("Legacy Happy relay row could not be retired");
          }
          binding = await sessionKeyStore.markLegacyRelayRetired(sessionId);
          bindingsBySessionId.set(sessionId, binding);
        }
        if (binding.relayTag === `seren-${sessionId}`) {
          binding = await sessionKeyStore.replacePendingTag(
            sessionId,
            `seren-migrated-${randomUUID()}`,
          );
          bindingsBySessionId.set(sessionId, binding);
        }
        const metadata = sessionMetadata(
          config,
          {
            sessionId,
            agentType: candidate.agentType,
            cwd: root.root,
            title: candidate.title,
            status: "initializing",
          },
          machineId,
        );
        const replacement = await getOrCreateUsableHappySession({
          api,
          tag: binding.relayTag,
          metadata,
          state: { controlledByUser: true },
          encryptionKey: binding.key,
          persistReady: async (happySessionId) => {
            binding = await sessionKeyStore.markReady(sessionId, happySessionId);
            bindingsBySessionId.set(sessionId, binding);
          },
        });
        if (!isUsableHappySession(replacement)) {
          throw new Error("Replacement Happy relay row could not be created");
        }
      }

      if (
        binding?.state !== "ready" ||
        typeof binding.happySessionId !== "string" ||
        binding.happySessionId === legacyHappySessionId ||
        binding.legacyRelayRetired !== true
      ) {
        throw new Error("Happy relay migration binding was inconsistent");
      }
      const migrated = await supervisorChannel.call(
        "conversation_migrate_happy_session",
        {
          conversationId: sessionId,
          expectedHappySessionId: legacyHappySessionId,
          replacementHappySessionId: binding.happySessionId,
        },
      );
      if (migrated?.migrated !== true) {
        throw new Error("Happy relay migration was not committed");
      }
      binding = await sessionKeyStore.clearLegacyRelayRetired(sessionId);
      bindingsBySessionId.set(sessionId, binding);
    }
  }

  async function discardUnclaimedSessionEntry(sessionId) {
    const creation = sessionCreationPromises.get(sessionId);
    if (creation) await creation.catch(() => null);
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    liveSessions.delete(sessionId);
    promptQueue.clear(sessionId);
    turnCorrelator.clear(sessionId);
    assistantMessageCoalescer.clear(sessionId);
    delete pendingRequests[sessionId];
    sessionCreationPromises.delete(sessionId);
    entry.liveness.stop();
    await entry.client.close().catch(() =>
      debug("failed to close relay client for a rejected ownership claim"),
    );
  }

  async function unwindStartupProviders(sessionIds) {
    const ids = [...new Set(sessionIds)];
    for (const sessionId of ids) {
      // Provider termination emits its terminal status before the RPC returns.
      // Reinstall the ownership fence first so that cleanup cannot retire the
      // durable relay binding that a future bridge restart must reuse.
      ownershipPendingSessions.add(sessionId);
      promptQueue.setBusy(sessionId, true);
    }
    await Promise.allSettled(ids.map((sessionId) => discardUnclaimedSessionEntry(sessionId)));
    await Promise.allSettled(ids.map((sessionId) => source.terminate(sessionId)));
    for (const sessionId of ids) {
      ownershipPendingProviderStatuses.delete(sessionId);
      promptQueue.clear(sessionId);
    }
  }

  async function restorePersistedProviderSessions(listed, blockedSessionIds) {
    const listedIds = new Set(listed.map((summary) => summary.sessionId));
    const bindings = await persistedSessionBindings();
    const restored = [];
    const spawnedByThisStartup = [];
    const unclaimedSpawnedSessions = new Set();
    const pendingStartupClaims = new Set();

    try {
      for (const binding of bindings) {
        if (
          binding.state !== "ready" ||
          listedIds.has(binding.sessionId) ||
          blockedSessionIds.has(binding.sessionId)
        ) {
          continue;
        }

        const lookup = await supervisorChannel.call("conversation_lookup", {
          providerSessionId: binding.sessionId,
          happySessionId: binding.happySessionId,
        });
        const happyOrigin = lookup?.happyOrigin === true;
        const shouldRetire = happyOrigin && lookup?.retire === true;
        if (shouldRetire) {
          const retired = await retirePersistedSession({
            sessionId: binding.sessionId,
            binding,
            providerAlreadyRetired: true,
            blockRevival: lookup?.archived === true,
            desktopAlreadyFenced: lookup?.archived === true,
          });
          if (!retired) {
            throw new Error("Invalid Happy provider binding could not be retired");
          }
          blockedSessionIds.add(binding.sessionId);
          continue;
        }
        // A ready binding can also belong to a desktop-originated session whose
        // provider will be restored by the frontend. Never infer Happy
        // ownership from the local/provider id alone.
        if (!happyOrigin || lookup?.restorable !== true) continue;

        if (
          lookup.conversationId !== binding.sessionId ||
          typeof lookup.agentType !== "string" ||
          typeof lookup.cwd !== "string"
        ) {
          throw new Error("Happy conversation lookup returned an invalid restore descriptor");
        }
        if (!RESTORABLE_HAPPY_AGENT_TYPES.has(lookup.agentType)) {
          const retired = await retirePersistedSession({
            sessionId: binding.sessionId,
            binding,
            providerAlreadyRetired: true,
          });
          if (!retired) {
            throw new Error("Unsupported Happy provider binding could not be retired");
          }
          blockedSessionIds.add(binding.sessionId);
          continue;
        }
        const root = validateSpawnRoot(lookup.cwd, advertisedRoots);
        if (!root.ok || root.root !== lookup.cwd) {
          const retired = await retirePersistedSession({
            sessionId: binding.sessionId,
            binding,
            providerAlreadyRetired: true,
          });
          if (!retired) {
            throw new Error("Out-of-scope Happy provider binding could not be retired");
          }
          blockedSessionIds.add(binding.sessionId);
          continue;
        }
        const hasStoredNativeSession =
          typeof lookup.agentSessionId === "string" && lookup.agentSessionId.length > 0;
        const canResumeExactNativeSession =
          hasStoredNativeSession && EXACT_RESUME_HAPPY_AGENT_TYPES.has(lookup.agentType);
        const spawnSpec = {
          agentType: lookup.agentType,
          cwd: root.root,
          localSessionId: binding.sessionId,
          ...(canResumeExactNativeSession
            ? {
                resumeAgentSessionId: lookup.agentSessionId,
                requireExactResume: true,
                suppressHistoryReplay: true,
              }
            : {
                freshContextReset: true,
                suppressHistoryReplay: true,
              }),
          ...(typeof lookup.agentModelId === "string" && lookup.agentModelId.length > 0
            ? { initialModelId: lookup.agentModelId }
            : {}),
          ...(typeof lookup.agentPermissionMode === "string" &&
          lookup.agentPermissionMode.length > 0
            ? { permissionMode: lookup.agentPermissionMode }
            : {}),
          approvalPolicy: defaultApprovalPolicy(lookup.agentType),
        };
        ownershipPendingSessions.add(binding.sessionId);
        pendingStartupClaims.add(binding.sessionId);
        promptQueue.setBusy(binding.sessionId, true);
        const spawned = await source.spawn(spawnSpec);
        if (typeof spawned?.sessionId === "string" && spawned.sessionId.length > 0) {
          // Spawning can reconfigure a same-ID process even when another caller
          // owns it. Until the atomic claim succeeds, every touched process must
          // be retired on failure so a stale permissive mode cannot survive.
          unclaimedSpawnedSessions.add(spawned.sessionId);
        }
        const owned = spawned?.owned === true;
        if (owned) spawnedByThisStartup.push(spawned.sessionId);
        if (
          spawned?.sessionId !== binding.sessionId ||
          spawned?.agentType !== lookup.agentType ||
          spawned?.cwd !== root.root ||
          typeof spawned?.agentSessionId !== "string" ||
          spawned.agentSessionId.length === 0
        ) {
          throw new Error("Happy provider restore did not preserve its exact identity");
        }

        const claim = await supervisorChannel.call("conversation_claim", {
          conversationId: binding.sessionId,
          providerSessionId: binding.sessionId,
          happySessionId: binding.happySessionId,
          cwd: root.root,
          expectedAgentType: lookup.agentType,
          expectedAgentSessionId: hasStoredNativeSession ? lookup.agentSessionId : null,
          expectedAgentPermissionMode:
            typeof lookup.agentPermissionMode === "string" ? lookup.agentPermissionMode : null,
          agentSessionId: spawned.agentSessionId,
        });
        if (claim?.archived === true) {
          // Archive wins over either caller's process ownership. A reused
          // exact provider is still the process backing this archived row.
          await source.terminate(binding.sessionId);
          unclaimedSpawnedSessions.delete(binding.sessionId);
          if (owned) {
            spawnedByThisStartup.splice(
              spawnedByThisStartup.lastIndexOf(binding.sessionId),
              1,
            );
          }
          const retired = await retirePersistedSession({
            sessionId: binding.sessionId,
            binding: {
              ...binding,
              conversationId: binding.sessionId,
              agentSessionId: spawned.agentSessionId,
            },
            providerAlreadyRetired: true,
            blockRevival: true,
            desktopAlreadyFenced: true,
          });
          if (!retired) throw new Error("Archived Happy provider binding could not be retired");
          pendingStartupClaims.delete(binding.sessionId);
          ownershipPendingSessions.delete(binding.sessionId);
          ownershipPendingProviderStatuses.delete(binding.sessionId);
          promptQueue.clear(binding.sessionId);
          blockedSessionIds.add(binding.sessionId);
          continue;
        }
        if (claim?.archived !== false) {
          throw new Error("Happy conversation ownership claim returned an invalid result");
        }
        unclaimedSpawnedSessions.delete(binding.sessionId);

        const observedStatus = ownershipPendingProviderStatuses.get(binding.sessionId);
        pendingStartupClaims.delete(binding.sessionId);
        ownershipPendingSessions.delete(binding.sessionId);
        ownershipPendingProviderStatuses.delete(binding.sessionId);

        const summary = {
          ...spawned,
          ...(typeof observedStatus === "string" ? { status: observedStatus } : {}),
          title: typeof lookup.title === "string" ? lookup.title : spawned.title,
          freshContextReset: !canResumeExactNativeSession,
        };
        promptQueue.setBusy(
          binding.sessionId,
          BUSY_SESSION_STATUSES.has(summary.status) || summary.status === "initializing",
        );
        sessionSummaries.set(summary.sessionId, summary);
        listedIds.add(summary.sessionId);
        restored.push(summary);
      }
      return { summaries: restored, ownedSessionIds: spawnedByThisStartup };
    } catch (error) {
      const sessionsToTerminate = new Set([
        ...spawnedByThisStartup,
        ...unclaimedSpawnedSessions,
      ]);
      await unwindStartupProviders(sessionsToTerminate);
      const abandonedPendingClaims = [...pendingStartupClaims].filter(
        (sessionId) => !sessionsToTerminate.has(sessionId),
      );
      await Promise.allSettled(
        abandonedPendingClaims.map((sessionId) => discardUnclaimedSessionEntry(sessionId)),
      );
      for (const sessionId of pendingStartupClaims) {
        ownershipPendingProviderStatuses.delete(sessionId);
        promptQueue.clear(sessionId);
        if (!sessionsToTerminate.has(sessionId)) {
          ownershipPendingSessions.delete(sessionId);
        }
      }
      throw error;
    }
  }

  function trackSessionDisposal(disposal) {
    sessionDisposals.add(disposal);
    void disposal.then(
      () => sessionDisposals.delete(disposal),
      () => sessionDisposals.delete(disposal),
    );
  }

  function trackLayerOperation(operation, failureMessage) {
    const handled = Promise.resolve(operation).catch(() => debug(failureMessage));
    layerOperations.add(handled);
    void handled.then(
      () => layerOperations.delete(handled),
      () => layerOperations.delete(handled),
    );
    return handled;
  }

  async function drainOperations(operations) {
    while (operations.size > 0) {
      await Promise.allSettled([...operations]);
    }
  }

  const promptQueue = createDeferredPromptQueue({
    send: async (_sessionId, queued) =>
      handleUserMessage(queued.entry, queued.message),
    shouldRetry: isPromptBusyError,
    onError: (_error, outcome) =>
      debug(
        outcome.deferred
          ? "deferred Happy inbound user message until provider is ready"
          : "ignored Happy inbound user message",
      ),
  });

  // Listing every session once per streamed event issued one provider RPC per
  // assistant delta. The scope/provider fields are cached; provider status
  // events merge a newly assigned native agentSessionId below.
  async function refreshSessionSummaries() {
    if (summariesRefreshPromise) return summariesRefreshPromise;
    summariesRefreshPromise = (async () => {
      const refreshRevision = sessionSummaryRevision;
      const listed = await source.listSessions();
      const previous = new Map(sessionSummaries);
      sessionSummaries.clear();
      for (const summary of listed) {
        const latest =
          (sessionSummaryRevisions.get(summary.sessionId) ?? 0) > refreshRevision
            ? { ...summary, ...previous.get(summary.sessionId) }
            : summary;
        sessionSummaries.set(summary.sessionId, latest);
        const entry = sessions.get(summary.sessionId);
        if (entry) entry.summary = latest;
      }
      // A provider event can introduce a session while the list RPC is in
      // flight. Retain that newer event-backed summary even if the older list
      // snapshot did not contain it.
      for (const [sessionId, summary] of previous) {
        if (
          !sessionSummaries.has(sessionId) &&
          (sessionSummaryRevisions.get(sessionId) ?? 0) > refreshRevision
        ) {
          sessionSummaries.set(sessionId, summary);
        }
      }
      return listed.map(
        (summary) => sessionSummaries.get(summary.sessionId) ?? summary,
      );
    })();
    try {
      return await summariesRefreshPromise;
    } finally {
      summariesRefreshPromise = null;
    }
  }

  async function sessionSummary(sessionId) {
    // A full app launch starts this bridge before frontend agent restoration.
    // Never negative-cache the initial empty list: the first provider event is
    // often the only signal that its restored session is now available.
    if (!sessionSummaries.has(sessionId)) await refreshSessionSummaries();
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
      promptQueue.clear(sessionId);
      turnCorrelator.clear(sessionId);
      assistantMessageCoalescer.clear(sessionId);
      delete pendingRequests[sessionId];
      sessionCreationPromises.delete(sessionId);
      await disposeHappySessionEntry({ api, entry, debugLog: debug })
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

  function retireTrackedSession(entry) {
    const sessionId = entry.sessionId;
    if (sessions.get(sessionId) !== entry) return;

    sessions.delete(sessionId);
    liveSessions.delete(sessionId);
    promptQueue.clear(sessionId);
    turnCorrelator.clear(sessionId);
    assistantMessageCoalescer.clear(sessionId);
    delete pendingRequests[sessionId];
    sessionCreationPromises.delete(sessionId);
    terminatedSessions.mark(sessionId);
    remotelyArchivedSessions.add(sessionId);
    entry.liveness.stop();
    const disposal = retirePersistedSession({
      sessionId,
      entry,
      terminateProvider: true,
      blockRevival: true,
    });
    trackSessionDisposal(disposal);
  }

  function registerInbound(entry) {
    const { client } = entry;
    client.on("inboundProcessingError", () => {
      entry.liveness.stop();
      supervisorChannel.notify("status_report", {
        state: "error",
        detail: "relay input processing failed",
      });
      debug("Happy relay input processing stopped after a durable processing failure");
    });
    client.on("archived", () => retireTrackedSession(entry));
    client.onUserMessage(async (message) => {
      const processed = await promptQueue.enqueue(entry.sessionId, { entry, message });
      if (!processed) {
        throw new Error("Happy user message was not accepted before session teardown");
      }
    });
    client.onFileEvent(async () => {
      // Provider runtimes do not accept binary/file attachments yet. Treat the
      // record as a terminal discard so its exact relay sequence can advance
      // without retrying it forever after every bridge restart.
      debug("discarded unsupported Happy file attachment");
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
    client.rpcHandlerManager.registerHandler("killSession", async (params) => {
      if (params === null) {
        debug("dropped unauthenticated Happy killSession request");
        return {
          success: false,
          message: "Unauthenticated kill request",
        };
      }
      retireTrackedSession(entry);
      return {
        success: true,
        message: "Killing happy-cli process",
      };
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
      return { accepted: false, terminalDiscard: true };
    }
    if (typeof message.content.text !== "string" || message.content.text.length === 0) {
      debug("dropped empty Happy user message");
      return { accepted: false, terminalDiscard: true };
    }
    const mode = message.meta?.permissionMode;
    if (message.meta && mode !== undefined && !isSupportedPermissionMode(mode)) {
      debug("dropped invalid Happy permission mode");
      return { accepted: false, terminalDiscard: true };
    }
    if (typeof mode === "string") await source.setPermissionMode(entry.sessionId, mode);
    return source.sendPrompt(entry.sessionId, message.content.text);
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

  async function createSessionEntry(sessionId, summary) {
    if (closing || identityResetting) throw new Error("Happy layer is closing");
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    if (!api || !identity) throw new Error("Happy API is not registered");
    if (await providerSessionIsArchived(sessionId)) {
      remotelyArchivedSessions.add(sessionId);
      terminatedSessions.mark(sessionId);
      await source
        .terminate(sessionId)
        .catch(() => debug("failed to terminate archived provider before relay creation"));
      return null;
    }
    const sessionApi = api;
    const machineId = identity.machineId ?? "seren-desktop";
    const metadata = sessionMetadata(config, summary, machineId);
    const legacyTag = `seren-${sessionId}`;
    let binding = sessionKeyStore
      ? await sessionKeyStore.getOrCreate(sessionId, legacyTag)
      : null;
    if (binding?.state === "retiring") {
      await retirePersistedSession({
        sessionId,
        binding,
        terminateProvider: true,
      });
      terminatedSessions.mark(sessionId);
      debug("retired provider restored after its Happy session was removed");
      return null;
    }
    if (
      binding?.state === "pending" &&
      binding.relayTag === legacyTag &&
      UUID_PATTERN.test(sessionId)
    ) {
      // Before stable ids, a Happy-created desktop conversation retained the
      // original relay id in its DB metadata but its relay tag used a temporary
      // `spawn-*` id. Its data key cannot be recovered; at least retire that
      // known row before creating the one-time decryptable replacement.
      const recorded = await supervisorChannel.call("conversation_happy_session_lookup", {
        conversationId: sessionId,
      });
      const previousHappySessionId = recorded?.happySessionId;
      if (typeof previousHappySessionId === "string" && previousHappySessionId.length > 0) {
        if (!(await sessionApi.deactivateSession(previousHappySessionId))) {
          throw new Error("Previous Happy relay row could not be retired");
        }
        // The archive endpoint retires the row, not its unique tag. Reusing
        // that tag with a newly generated data key returns the old ciphertext
        // and fails during decrypt, so persist the replacement tag before its
        // POST and make a crash retry use the same safe row.
        binding = await sessionKeyStore.replacePendingTag(
          sessionId,
          `seren-migrated-${randomUUID()}`,
        );
      }
    }
    const resumedBinding = binding?.state === "ready";
    const firstLegacyBinding =
      binding?.state === "pending" && binding.relayTag === legacyTag;
    const session = await getOrCreateUsableHappySession({
      api: sessionApi,
      tag: binding?.relayTag ?? legacyTag,
      metadata,
      state: { controlledByUser: true },
      encryptionKey: binding?.key,
      expectedSessionId: binding?.state === "ready" ? binding.happySessionId : undefined,
      allowLegacyReplacement: binding?.state === "pending" && binding.relayTag === legacyTag,
      debugLog: debug,
      replacementTag: `seren-v2-${randomUUID()}`,
      persistReplacementTag: async (relayTag) => {
        await sessionKeyStore?.replacePendingTag(sessionId, relayTag);
      },
      persistReady: async (happySessionId) => {
        await sessionKeyStore?.markReady(sessionId, happySessionId);
      },
    });
    // The relay lookup can outlive bridge shutdown. Do not create a socket or
    // heartbeat after close() has already drained the tracked entries.
    if (closing || identityResetting) {
      if (isUsableHappySession(session)) await sessionApi.deactivateSession(session.id);
      throw new Error("Happy layer is closing");
    }
    if (!isUsableHappySession(session)) {
      throw new Error("Happy relay did not return a usable session");
    }
    if (
      session.metadata.lifecycleState === "archiveRequested" ||
      session.metadata.lifecycleState === "archived"
    ) {
      remotelyArchivedSessions.add(sessionId);
      terminatedSessions.mark(sessionId);
      await retirePersistedSession({
        sessionId,
        binding: { ...(binding ?? {}), state: "ready", happySessionId: session.id },
        terminateProvider: true,
        blockRevival: true,
        agentSessionId: summary?.agentSessionId,
      });
      return null;
    }

    // A terminal/archive event can overtake the relay lookup while this entry
    // is still unregistered. Re-check the lifecycle fence before constructing
    // a socket or heartbeat so that event cannot return while leaving a hidden
    // live entry behind.
    const creationWasTerminated = terminatedSessions.has(sessionId);
    const creationWasArchived = remotelyArchivedSessions.has(sessionId);
    if (creationWasTerminated || creationWasArchived) {
      const retiringBinding = await persistedSessionBinding(sessionId);
      if (retiringBinding) {
        await retirePersistedSession({
          sessionId,
          binding: retiringBinding,
          terminateProvider: creationWasArchived && !creationWasTerminated,
          providerAlreadyRetired: creationWasTerminated,
          blockRevival: creationWasArchived,
          agentSessionId: summary?.agentSessionId,
        });
      } else {
        if (creationWasArchived && !creationWasTerminated) {
          await source
            .terminate(sessionId)
            .catch(() => debug("failed to terminate archived provider during relay creation"));
        }
        await sessionApi
          .deactivateSession(session.id)
          .catch(() => debug("failed to deactivate superseded Happy relay row"));
      }
      return null;
    }
    if (!isSessionInScope(summary)) {
      await sessionApi
        .deactivateSession(session.id)
        .catch(() => debug("failed to deactivate Happy session after roots changed"));
      debug("discarded Happy session after its root left scope during relay creation");
      return null;
    }

    // Provider status can advance while relay/key-store HTTP calls above are
    // pending. Install the entry from the latest authoritative summary so an
    // early completion cannot be overwritten by the stale list snapshot.
    summary = sessionSummaries.get(sessionId) ?? summary;

    let client;
    const relaySnapshotSeq = Number.isSafeInteger(session.seq) && session.seq >= 0
      ? session.seq
      : 0;
    let resumeFromSeq = 0;
    try {
      if (resumedBinding) {
        if (Number.isSafeInteger(binding.processedThroughSeq)) {
          if (binding.processedThroughSeq > relaySnapshotSeq) {
            throw new Error("Persisted Happy processed sequence exceeds the relay snapshot");
          }
          resumeFromSeq = binding.processedThroughSeq;
        } else {
          // One-time migration for bindings written before durable inbound
          // cursors existed. The old bridge already observed this snapshot and
          // cannot prove which records were acted on, so seed at its high-water
          // mark rather than replaying an arbitrary historical prompt.
          await sessionKeyStore.markProcessedThroughSeq(sessionId, relaySnapshotSeq);
          resumeFromSeq = relaySnapshotSeq;
        }
      } else if (firstLegacyBinding) {
        // v3.72 had no durable binding/cursor. The POST snapshot is the exact
        // high-water mark before this socket starts: seeding it prevents old
        // inbound prompts from replaying, while records arriving after the
        // response receive a larger sequence and are still delivered.
        await sessionKeyStore.markProcessedThroughSeq(sessionId, relaySnapshotSeq);
        resumeFromSeq = relaySnapshotSeq;
      }
      client = sessionApi.sessionSyncClient(session, {
        resumeFromSeq,
        onMessageProcessed: async (seq) => {
          const persisted = await sessionKeyStore.markProcessedThroughSeq(sessionId, seq);
          if (persisted.processedThroughSeq !== seq) {
            throw new Error("Happy processed sequence did not advance exactly");
          }
        },
      });
    } catch (error) {
      if (!resumedBinding) await sessionApi.deactivateSession(session.id);
      throw error;
    }
    // Do not rewrite lifecycle metadata when resuming. A mobile archive can
    // land after the GET snapshot; an optimistic update retry would otherwise
    // overwrite that newer archiveRequested value back to running.
    const thinking = BUSY_SESSION_STATUSES.has(summary?.status);
    let entry;
    try {
      entry = {
        sessionId,
        happySessionId: session.id,
        summary,
        session,
        client,
        suppressProviderHistoryReplay: resumedBinding,
        liveness: createSessionLiveness(client, thinking),
      };
      sessions.set(sessionId, entry);
      liveSessions.add(sessionId);
      promptQueue.setBusy(
        sessionId,
        thinking || summary?.status === "initializing" || ownershipPendingSessions.has(sessionId),
      );
      rememberPendingPermissions(sessionId, summary?.pendingPermissions);
      registerInbound(entry);
      // ApiSessionClient connects inside its constructor. Its durable latch
      // closes the constructor-to-listener window without changing the SDK's
      // EventEmitter behavior for other consumers.
      if (client.hasArchiveSignal?.()) {
        client.emit("archived");
      }
      if (sessions.get(sessionId) !== entry) return null;
      client.sendSessionEvent({ type: "switch", mode: "remote" });
      return entry;
    } catch (error) {
      sessions.delete(sessionId);
      liveSessions.delete(sessionId);
      promptQueue.clear(sessionId);
      turnCorrelator.clear(sessionId);
      assistantMessageCoalescer.clear(sessionId);
      delete pendingRequests[sessionId];
      entry?.liveness?.stop();
      await Promise.allSettled([sessionApi.deactivateSession(session.id), client.close()]);
      throw error;
    }
  }

  async function findOrCreateSession(sessionId, summary = null) {
    if (closing || identityResetting) return null;
    if (remotelyArchivedSessions.has(sessionId)) return null;
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
      if (sessionCreationPromises.get(sessionId) === creation) {
        sessionCreationPromises.delete(sessionId);
      }
    }
  }

  async function publishEvent(event) {
    const providerStatus = event.kind === "status" ? event.payload?.status : null;
    const readinessUnchanged = event.payload?.readinessUnchanged === true;
    const providerThinking =
      !readinessUnchanged && BUSY_SESSION_STATUSES.has(providerStatus);
    const providerReady =
      !readinessUnchanged &&
      (event.kind === "turn-complete" ||
        event.kind === "error" ||
        ["ready", "idle", "completed"].includes(providerStatus));
    if (ownershipPendingSessions.has(event.sessionId)) {
      if (providerThinking) {
        ownershipPendingProviderStatuses.set(event.sessionId, providerStatus);
      } else if (providerReady) {
        ownershipPendingProviderStatuses.set(event.sessionId, "ready");
      }
      // The provider is not authorized to own this desktop/relay identity
      // until its atomic claim succeeds. Keep all output and entry creation
      // behind that fence; the latest readiness is replayed from the spawn
      // snapshot after ownership is established.
      return;
    }
    // An entry only exists if it passed the scope check when it was created, so
    // a tracked session stays tracked; an unknown one is gated here, before any
    // bookkeeping, so out-of-scope sessions accumulate no state either.
    const terminal =
      event.kind === "status" && ["error", "terminated"].includes(event.payload?.status);
    if (remotelyArchivedSessions.has(event.sessionId)) {
      let retiringBinding = null;
      try {
        retiringBinding = await persistedSessionBinding(event.sessionId);
      } catch {
        debug("failed to read archived Happy session binding");
      }
      if (retiringBinding?.state === "retiring") {
        await retirePersistedSession({
          sessionId: event.sessionId,
          binding: retiringBinding,
          terminateProvider: !terminal,
          providerAlreadyRetired: terminal,
        });
      } else if (!terminal) {
        await source.terminate(event.sessionId).catch(() =>
          debug("failed to terminate a late restored archived provider"),
        );
      }
      return;
    }
    const trackedBeforeReplay = sessions.get(event.sessionId);
    if (
      trackedBeforeReplay?.suppressProviderHistoryReplay === true &&
      (event.payload?.replay === true || event.payload?.historyReplay === true)
    ) {
      return;
    }
    let summary =
      (await sessionSummary(event.sessionId)) ?? sessions.get(event.sessionId)?.summary ?? null;
    const observedAgentSessionId = event.payload?.agentSessionId;
    if (summary) {
      const observedStatus = providerThinking
        ? providerStatus
        : providerReady
          ? providerStatus ?? "ready"
          : null;
      summary = {
        ...summary,
        ...(observedStatus ? { status: observedStatus } : {}),
        ...(typeof observedAgentSessionId === "string" && observedAgentSessionId.length > 0
          ? { agentSessionId: observedAgentSessionId }
          : {}),
      };
      sessionSummaries.set(event.sessionId, summary);
      sessionSummaryRevision += 1;
      sessionSummaryRevisions.set(event.sessionId, sessionSummaryRevision);
      const trackedEntry = sessions.get(event.sessionId);
      if (trackedEntry) trackedEntry.summary = summary;
    }
    if (terminal && !sessions.has(event.sessionId)) {
      liveSessions.delete(event.sessionId);
      promptQueue.clear(event.sessionId);
      delete pendingRequests[event.sessionId];
      terminatedSessions.mark(event.sessionId);
      const binding = await persistedSessionBinding(event.sessionId);
      if (binding) {
        await retirePersistedSession({
          sessionId: event.sessionId,
          binding,
          providerAlreadyRetired: true,
        });
      }
      return;
    }
    if (!sessions.has(event.sessionId)) {
      const retiringBinding = await persistedSessionBinding(event.sessionId);
      if (retiringBinding?.state === "retiring") {
        await retirePersistedSession({
          sessionId: event.sessionId,
          binding: retiringBinding,
          terminateProvider: true,
        });
        terminatedSessions.mark(event.sessionId);
        return;
      }
    }
    if (!sessions.has(event.sessionId) && !isSessionInScope(summary)) {
      debug("dropped event for session outside advertised roots");
      return;
    }
    if (providerThinking) {
      promptQueue.setBusy(event.sessionId, true);
    } else if (providerReady && !ownershipPendingSessions.has(event.sessionId)) {
      promptQueue.setBusy(event.sessionId, false);
    }
    if (terminal) {
      liveSessions.delete(event.sessionId);
      promptQueue.clear(event.sessionId);
      delete pendingRequests[event.sessionId];
      terminatedSessions.mark(event.sessionId);
    } else {
      liveSessions.add(event.sessionId);
      terminatedSessions.forget(event.sessionId);
    }
    rememberPermission(event);
    const entry = await findOrCreateSession(event.sessionId, summary);
    if (!entry) return;
    if (
      entry.suppressProviderHistoryReplay === true &&
      (event.payload?.replay === true || event.payload?.historyReplay === true)
    ) {
      return;
    }
    if (providerThinking) {
      entry.liveness.setThinking(true);
    } else if (providerReady) {
      entry.liveness.setThinking(false);
    }
    const provider = summary?.agentType === "claude-code" ? "claude" : summary?.agentType ?? "codex";
    const correlatedEvent = turnCorrelator.correlate(event);
    for (const publishableEvent of assistantMessageCoalescer.consume(correlatedEvent)) {
      for (const message of translateNeutralEvent(publishableEvent, { provider })) {
        if (message.transport === "session") entry.client.sendSessionProtocolMessage(message.envelope);
        if (message.transport === "agent") entry.client.sendAgentMessage(message.provider, message.body);
      }
    }
    if (terminal) {
      await completeTerminalSession({
        sessions,
        sessionId: event.sessionId,
        entry,
        send: async () => {},
        dispose: (terminalEntry) =>
          retirePersistedSession({
            sessionId: event.sessionId,
            entry: terminalEntry,
            providerAlreadyRetired: true,
          }),
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

  async function performSpawn(options) {
    if (closing || identityResetting) {
      return { type: "error", errorMessage: "Happy session bridge is stopping" };
    }
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
    // Preallocate the final desktop/provider id before creating the relay row.
    // Deriving the row key from a throwaway pending id would make a remotely
    // spawned session unrecoverable under its persisted id after restart.
    const pendingSessionId = randomUUID();
    let pending = null;
    let conversationCreated = false;
    let providerSpawnAttempted = false;
    let providerConfirmedAbsent = false;
    let pendingProviderRetired = false;
    let unexpectedProviderSessionId = null;
    let claimAttempted = false;
    let archiveWon = false;
    let pendingDisposed = false;
    ownershipPendingSessions.add(pendingSessionId);
    try {
      // Entry creation itself persists the key/tag and can create the relay
      // row. Keep it inside the unwind scope so a client-construction failure
      // cannot strand a ready binding that startup would keep forever.
      pending = await createSessionEntry(pendingSessionId, {
        sessionId: pendingSessionId,
        agentType,
        cwd: validation.root,
        title: `${agentType} Agent`,
        status: "initializing",
      });
      if (!pending) throw new Error("Happy session closed before provider spawn");
      const conversation = await supervisorChannel.call("conversation_create", {
        conversationId: pendingSessionId,
        agentType,
        cwd: validation.root,
        title: `${agentType} Agent`,
        happySessionId: pending.happySessionId,
      });
      conversationCreated = true;
      if (conversation.conversationId !== pendingSessionId) {
        throw new Error("conversation id did not match the preallocated session id");
      }
      if (closing || identityResetting || sessions.get(pendingSessionId) !== pending) {
        throw new Error("Happy session closed before provider spawn");
      }
      providerSpawnAttempted = true;
      let spawned;
      try {
        spawned = await source.spawn({
          agentType,
          cwd: validation.root,
          localSessionId: conversation.conversationId,
          approvalPolicy: defaultApprovalPolicy(agentType),
        });
        } catch (error) {
          providerConfirmedAbsent = error?.providerRequestRejected === true;
          throw error;
        }
      if (!spawned?.sessionId) throw new Error("provider spawn returned no session");
      if (closing || identityResetting || sessions.get(pendingSessionId) !== pending) {
        try {
          await source.terminate(spawned.sessionId);
          pendingProviderRetired = spawned.sessionId === pendingSessionId;
          providerConfirmedAbsent = spawned.sessionId !== pendingSessionId;
        } catch {
          if (spawned.sessionId !== pendingSessionId) {
            unexpectedProviderSessionId = spawned.sessionId;
            providerConfirmedAbsent = true;
          }
          debug("failed to terminate provider spawned after Happy session closed");
        }
        throw new Error("Happy session closed during provider spawn");
      }
      if (spawned.sessionId !== pendingSessionId) {
        providerConfirmedAbsent = true;
        try {
          await source.terminate(spawned.sessionId);
        } catch {
          unexpectedProviderSessionId = spawned.sessionId;
          debug("failed to terminate provider with mismatched session id");
        }
        throw new Error("provider did not preserve the preallocated session id");
      }
      claimAttempted = true;
      const claim = await supervisorChannel.call("conversation_claim", {
        conversationId: pendingSessionId,
        providerSessionId: pendingSessionId,
        happySessionId: pending.happySessionId,
        cwd: validation.root,
        expectedAgentType: agentType,
        expectedAgentSessionId: null,
        expectedAgentPermissionMode: null,
        agentSessionId:
          typeof spawned.agentSessionId === "string" && spawned.agentSessionId.length > 0
            ? spawned.agentSessionId
            : null,
      });
      if (claim?.archived === true) {
        archiveWon = true;
        // The frontend can win the same-ID spawn flight, returning owned:false.
        // The archived claim still fences this exact provider process.
        await source.terminate(pendingSessionId);
        pendingProviderRetired = true;
        await discardPendingSpawn(pendingSessionId, pending, {
          providerAlreadyRetired: true,
          blockRevival: true,
          desktopAlreadyFenced: true,
          conversationId: pendingSessionId,
          agentSessionId: spawned.agentSessionId,
        });
        pendingDisposed = true;
        throw new Error("Happy conversation was archived during provider spawn");
      }
      if (claim?.archived !== false) {
        throw new Error("Happy conversation ownership claim returned an invalid result");
      }
      const observedStatus = ownershipPendingProviderStatuses.get(pendingSessionId);
      const claimedSummary =
        typeof observedStatus === "string" ? { ...spawned, status: observedStatus } : spawned;
      pending.summary = claimedSummary;
      liveSessions.add(pendingSessionId);
      // Seed the cache so the first streamed event resolves this session's
      // provider without re-listing.
      sessionSummaries.set(pendingSessionId, claimedSummary);
      ownershipPendingSessions.delete(pendingSessionId);
      ownershipPendingProviderStatuses.delete(pendingSessionId);
      promptQueue.setBusy(
        pendingSessionId,
        BUSY_SESSION_STATUSES.has(claimedSummary.status) ||
          claimedSummary.status === "initializing",
      );
      return { type: "success", sessionId: pending.happySessionId };
    } catch (error) {
      ownershipPendingSessions.delete(pendingSessionId);
      ownershipPendingProviderStatuses.delete(pendingSessionId);
      if (unexpectedProviderSessionId) {
        await source
          .terminate(unexpectedProviderSessionId)
          .catch(() => debug("failed to retry mismatched provider termination"));
      }
      if (!pendingDisposed) {
        await discardPendingSpawn(pendingSessionId, pending, {
          providerNeverStarted: !providerSpawnAttempted || providerConfirmedAbsent,
          providerAlreadyRetired: pendingProviderRetired,
        });
      }
      if (conversationCreated && !claimAttempted && !archiveWon) {
        await supervisorChannel
          .call("conversation_delete", { conversationId: pendingSessionId })
          .catch(() => debug("failed to roll back abandoned Happy conversation"));
      }
      debug("failed to spawn Happy session");
      return {
        type: "error",
        errorMessage: error instanceof Error ? error.message : "spawn failed",
      };
    }
  }

  function handleSpawn(options) {
    const operation = performSpawn(options);
    spawnOperations.add(operation);
    void operation.then(
      () => spawnOperations.delete(operation),
      () => spawnOperations.delete(operation),
    );
    return operation;
  }

  async function retireIdentitySessions() {
    if (identityResetPromise) return identityResetPromise;
    identityResetting = true;
    sourceSubscription?.();
    sourceSubscription = null;
    identityResetPromise = (async () => {
      await Promise.allSettled([...spawnOperations]);
      await Promise.allSettled([...sessionCreationPromises.values()]);
      if (!api) return false;

      let bindings;
      try {
        bindings = await persistedSessionBindings();
      } catch {
        debug("failed to read Happy session bindings for identity reset");
        return false;
      }

      const relaySessionIds = new Set(
        [...sessions.values()].map((entry) => entry.happySessionId),
      );
      const resolvedBindings = await Promise.all(
        bindings.map(async (binding) => {
          if (typeof binding.happySessionId === "string") {
            return binding.happySessionId;
          }
          try {
            const resolved = await api.getOrCreateSession({
              tag: binding.relayTag,
              metadata: {
                path: os.homedir(),
                host: config.machineName,
                name: "Retiring Seren session",
                lifecycleState: "archived",
              },
              state: { controlledByUser: true },
              encryptionKey: binding.key,
            });
            return typeof resolved?.id === "string" && resolved.id.length > 0
              ? resolved.id
              : null;
          } catch {
            return null;
          }
        }),
      );
      if (resolvedBindings.some((happySessionId) => happySessionId === null)) {
        debug("failed to resolve Happy session during identity reset");
        return false;
      }
      for (const happySessionId of resolvedBindings) relaySessionIds.add(happySessionId);

      for (const entry of sessions.values()) entry.liveness.stop();
      const results = await Promise.all(
        [...relaySessionIds].map(async (happySessionId) => {
          try {
            return await api.deactivateSession(happySessionId);
          } catch {
            return false;
          }
        }),
      );
      if (results.some((retired) => !retired)) {
        debug("failed to retire every Happy session before identity reset");
        return false;
      }

      // The relay rows are now confirmed inactive. Do not wait for SDK outbox
      // flushing here: Rust stops this child immediately after the reset ack,
      // and a slow socket close must not make an otherwise complete reset time
      // out and revive the old identity.
      sessions.clear();
      return true;
    })();
    return identityResetPromise;
  }

  // Registered once, from `start()`, and torn down in `close()`. A single
  // listener keeps `dispatchNotification`'s queueing behaviour intact — it stops
  // queueing as soon as any listener exists, so adding a second one elsewhere
  // would drop notifications this one is waiting for. It also has to stay
  // attached across the pairing wait, which is exactly when `cancel_pairing`
  // arrives. Returns the unsubscribe handle the caller stores.
  function subscribeToSupervisor() {
    return supervisorChannel.onNotification((method, params) => {
      if (method === "roots_update") {
        advertisedRoots = Array.isArray(params?.roots) ? params.roots : [];
        void trackLayerOperation(
          (async () => {
            await dropSessionsOutOfScope();
            await updateCapabilities();
          })(),
          "failed to apply Happy roots update",
        );
        return;
      }
      if (method === "cancel_pairing") {
        cancelPairing();
        return;
      }
      if (method === "identity_reset") {
        const requestId = params?.requestId;
        if (typeof requestId !== "string" || requestId.length > 64) return;
        void trackLayerOperation(
          retireIdentitySessions()
            .then((success) => {
              supervisorChannel.notify("identity_reset_result", { requestId, success });
            })
            .catch(() => {
              supervisorChannel.notify("identity_reset_result", { requestId, success: false });
            }),
          "failed to reset Happy identity",
        );
        return;
      }
      if (method === "provider_session_retire") {
        const sessionId = params?.providerSessionId;
        if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) return;
        void trackLayerOperation(
          retireProviderSessionFromDesktop(sessionId),
          "failed to retire provider session fenced by desktop",
        );
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

  async function discardPendingSpawn(
    pendingSessionId,
    pending,
    {
      providerNeverStarted = false,
      providerAlreadyRetired = false,
      blockRevival = false,
      desktopAlreadyFenced = false,
      conversationId,
      agentSessionId,
    } = {},
  ) {
    if (pending && sessions.get(pendingSessionId) === pending) {
      sessions.delete(pendingSessionId);
      liveSessions.delete(pendingSessionId);
      turnCorrelator.clear(pendingSessionId);
      assistantMessageCoalescer.clear(pendingSessionId);
      delete pendingRequests[pendingSessionId];
      sessionCreationPromises.delete(pendingSessionId);
    }
    promptQueue.clear(pendingSessionId);
    const binding = pending ? null : await persistedSessionBinding(pendingSessionId);
    if (!pending && !binding) return;
    const providerIsRetired = providerNeverStarted || providerAlreadyRetired;
    await retirePersistedSession({
      sessionId: pendingSessionId,
      ...(pending ? { entry: pending } : { binding }),
      terminateProvider: !providerIsRetired,
      providerAlreadyRetired: providerIsRetired,
      blockRevival,
      desktopAlreadyFenced,
      conversationId,
      agentSessionId,
    });
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
    initializeSessionKeyStore();
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
      let result;
      try {
        result = await readAuthRequest(config.relayUrl, keyPair.publicKey, signal);
      } catch (error) {
        if (pairingCancelled || error?.name === "AbortError") throw error;
        if (!isRetryableAuthPollError(error)) throw error;
        debug("pairing authorization poll retrying after ECONNRESET");
        await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS));
        continue;
      }
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
    // Cancelling and immediately re-pairing leaves the abandoned attempt still
    // settling. Releasing the slot is gated on this attempt still owning it, so
    // an aborted attempt cannot clear its successor and let a third keypair be
    // minted while the second is still polling.
    const attempt = (async () => {
      const keyPair = nacl.box.keyPair();
      await postAuthRequest(config.relayUrl, keyPair.publicKey);
      const payload = `happy://terminal?${encodeBase64Url(keyPair.publicKey)}`;
      latestPairingPayload = payload;
      supervisorChannel.notify("pairing_payload", { payload });
      const abortController = new AbortController();
      pairingAbortController = abortController;
      const releaseAttempt = () => {
        if (pairingPromise === attempt) pairingPromise = null;
      };
      pairingAuthorizationPromise = waitForAuthorization(keyPair, abortController.signal)
        .then((authorized) => {
          if (!authorized) releaseAttempt();
        })
        .catch((error) => {
          releaseAttempt();
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
    pairingPromise = attempt;
    return attempt;
  }

  async function finishRegistration() {
    return startupStatusGate.complete(async () => {
      // The provider client buffers per-session notifications until subscribe.
      // Complete the one-time pre-key-store relay migration and every atomic
      // restore claim first: flushing a queued status any earlier could create
      // an inbound relay handler for a provider that does not own the desktop
      // conversation yet.
      await updateCapabilities();
      const listed = await refreshSessionSummaries();
      const blockedSessionIds = await reconcilePersistedSessions(listed);
      await migrateLegacyHappyProviderBindings(blockedSessionIds);
      const restored = await restorePersistedProviderSessions(listed, blockedSessionIds);
      sourceSubscription?.();
      sourceSubscription = source.subscribe((event) => {
        void trackLayerOperation(
          publishEvent(event),
          "failed to publish Happy session event",
        );
      });
      try {
        for (const summary of [...listed, ...restored.summaries]) {
          if (blockedSessionIds.has(summary.sessionId)) continue;
          if (!isSessionInScope(summary)) continue;
          const entry = await findOrCreateSession(
            summary.sessionId,
            sessionSummaries.get(summary.sessionId) ?? summary,
          );
          if (entry && summary.freshContextReset === true) {
            for (const message of translateNeutralEvent({
              kind: "service-message",
              sessionId: summary.sessionId,
              payload: { text: HAPPY_CONTEXT_RESET_NOTICE },
            })) {
              if (message.transport === "session") {
                entry.client.sendSessionProtocolMessage(message.envelope);
              }
            }
          }
        }
      } catch (error) {
        await unwindStartupProviders(restored.ownedSessionIds);
        throw error;
      }
    });
  }

  return {
    async start() {
      supervisorSubscription = subscribeToSupervisor();
      if (await registerMachine()) {
        await finishRegistration();
        return;
      }
      return startPairing();
    },
    startPairing,
    async close() {
      closing = true;
      sourceSubscription?.();
      supervisorSubscription?.();
      await promptQueue.close();
      turnCorrelator.close();
      assistantMessageCoalescer.close();
      cancelPairing();
      await pairingAuthorizationPromise;
      // A remote spawn may already own a persisted relay row while provider
      // creation is still in flight. The Rust supervisor bounds shutdown; wait
      // here so performSpawn can durably unwind before this process exits.
      await drainOperations(spawnOperations);
      await drainOperations(layerOperations);
      await Promise.allSettled([...sessionCreationPromises.values()]);
      // Shutdown is a passive detach. Provider crashes, updater restarts, app
      // restarts, and the Off -> On pause must preserve the active relay row.
      // Await each SDK close so accepted inbound work reaches its durable cursor.
      await Promise.allSettled(
        [...sessions.values()].map(async (entry) => {
          entry.liveness.stop();
          await entry.client.close().catch(() =>
            debug("failed to detach Happy session client"),
          );
        }),
      );
      sessions.clear();
      await drainOperations(sessionDisposals);
      sessionDisposals.clear();
      remotelyArchivedSessions.clear();
      ownershipPendingSessions.clear();
      ownershipPendingProviderStatuses.clear();
      terminatedSessions.clear();
      machineClient?.shutdown();
      machineClient = null;
      api = null;
    },
  };
}

export async function completeTerminalSession({ sessions, sessionId, entry, send, dispose }) {
  await send(entry);
  sessions.delete(sessionId);
  await (dispose ? dispose(entry) : entry.client.close());
}
