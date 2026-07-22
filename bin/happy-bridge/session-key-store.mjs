// ABOUTME: Persists Happy session data keys without exposing session identifiers at rest.
// ABOUTME: Uses a pairing-key-derived KEK, authenticated encryption, and atomic serialized writes.

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const HAPPY_SESSION_KEY_STORE_FILENAME = "happy-session-keys.v1.json";

const STORE_VERSION = 1;
const PAYLOAD_VERSION = 1;
const SESSION_KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_SESSION_ID_BYTES = 512;
const MAX_RELAY_TAG_BYTES = 1_024;
const MAX_RELAY_SESSION_ID_BYTES = 512;
const MAX_ENTRIES = 1_024;
const MAX_PLAINTEXT_BYTES = 700_000;
const MAX_STORE_FILE_BYTES = 1_048_576;
const KEK_CONTEXT = Buffer.from("seren-desktop/happy-session-key-store/kek/v1", "utf8");
const FILE_AAD = Buffer.from("seren-desktop/happy-session-key-store/file/v1", "utf8");
const operationQueues = new Map();

export class HappySessionKeyStoreError extends Error {
  constructor(cause) {
    super("Happy session key store could not be authenticated", { cause });
    this.name = "HappySessionKeyStoreError";
    this.code = "ERR_HAPPY_SESSION_KEY_STORE_INVALID";
  }
}

function invalidStore(cause) {
  return cause instanceof HappySessionKeyStoreError
    ? cause
    : new HappySessionKeyStoreError(cause);
}

function copyMachineKey(machineKey) {
  if (!(machineKey instanceof Uint8Array) || machineKey.byteLength !== SESSION_KEY_BYTES) {
    throw new TypeError("Happy pairing machine key must be a 32-byte Uint8Array");
  }
  return Buffer.from(machineKey);
}

function resolveStorePath(directory) {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.includes("\0") ||
    Buffer.byteLength(directory, "utf8") > 4_096
  ) {
    throw new TypeError("Happy session key store directory is invalid");
  }
  return path.join(path.resolve(directory), HAPPY_SESSION_KEY_STORE_FILENAME);
}

function validateSessionId(sessionId) {
  const byteLength = typeof sessionId === "string" ? Buffer.byteLength(sessionId, "utf8") : 0;
  if (byteLength === 0 || byteLength > MAX_SESSION_ID_BYTES || sessionId.includes("\0")) {
    throw new TypeError(`Happy session id must be between 1 and ${MAX_SESSION_ID_BYTES} bytes`);
  }
  return sessionId;
}

function validateRelayTag(relayTag) {
  const byteLength = typeof relayTag === "string" ? Buffer.byteLength(relayTag, "utf8") : 0;
  if (byteLength === 0 || byteLength > MAX_RELAY_TAG_BYTES || relayTag.includes("\0")) {
    throw new TypeError(`Happy relay tag must be between 1 and ${MAX_RELAY_TAG_BYTES} bytes`);
  }
  return relayTag;
}

function validateRelaySessionId(sessionId) {
  const byteLength = typeof sessionId === "string" ? Buffer.byteLength(sessionId, "utf8") : 0;
  if (
    byteLength === 0 ||
    byteLength > MAX_RELAY_SESSION_ID_BYTES ||
    sessionId.includes("\0")
  ) {
    throw new TypeError(
      `Happy relay session id must be between 1 and ${MAX_RELAY_SESSION_ID_BYTES} bytes`,
    );
  }
  return sessionId;
}

function validateAgentSessionId(sessionId) {
  const byteLength = typeof sessionId === "string" ? Buffer.byteLength(sessionId, "utf8") : 0;
  if (byteLength === 0 || byteLength > MAX_SESSION_ID_BYTES || sessionId.includes("\0")) {
    throw new TypeError(
      `Happy agent session id must be between 1 and ${MAX_SESSION_ID_BYTES} bytes`,
    );
  }
  return sessionId;
}

function copyBinding(binding) {
  return {
    state: binding.state,
    relayTag: binding.relayTag,
    key: new Uint8Array(binding.key),
    ...(binding.state === "retiring"
      ? {
          blockRevival: binding.blockRevival,
          providerRetired: binding.providerRetired,
          ...(typeof binding.conversationId === "string"
            ? { conversationId: binding.conversationId }
            : {}),
          ...(typeof binding.agentSessionId === "string"
            ? { agentSessionId: binding.agentSessionId }
            : {}),
        }
      : {}),
    ...(typeof binding.happySessionId === "string"
      ? { happySessionId: binding.happySessionId }
      : {}),
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCanonicalBase64(value, expectedBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_STORE_FILE_BYTES ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw invalidStore();
  }
  const decoded = Buffer.from(value, "base64");
  if (
    (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) ||
    decoded.toString("base64") !== value
  ) {
    throw invalidStore();
  }
  return decoded;
}

function deriveKek(machineKey, salt) {
  return Buffer.from(hkdfSync("sha256", machineKey, salt, KEK_CONTEXT, SESSION_KEY_BYTES));
}

function parsePayload(plaintext) {
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw invalidStore();
  }

  let payload;
  try {
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    throw invalidStore(error);
  }
  if (
    !isRecord(payload) ||
    payload.version !== PAYLOAD_VERSION ||
    !Array.isArray(payload.entries) ||
    payload.entries.length > MAX_ENTRIES
  ) {
    throw invalidStore();
  }

  const entries = new Map();
  try {
    for (const entry of payload.entries) {
      if (!isRecord(entry)) throw invalidStore();
      const hasHappySessionId = Object.hasOwn(entry, "happySessionId");
      const hasConversationId = Object.hasOwn(entry, "conversationId");
      const hasAgentSessionId = Object.hasOwn(entry, "agentSessionId");
      const expectedKeys =
        entry.state === "retiring"
          ? [
              ...(hasAgentSessionId ? ["agentSessionId"] : []),
              "blockRevival",
              "key",
              "providerRetired",
              "relayTag",
              "sessionId",
              "state",
              ...(hasConversationId ? ["conversationId"] : []),
              ...(hasHappySessionId ? ["happySessionId"] : []),
            ].sort()
          : hasHappySessionId
            ? ["happySessionId", "key", "relayTag", "sessionId", "state"]
            : ["key", "relayTag", "sessionId", "state"];
      if (Object.keys(entry).sort().join("\0") !== expectedKeys.join("\0")) {
        throw invalidStore();
      }
      const sessionId = validateSessionId(entry.sessionId);
      if (entries.has(sessionId)) throw invalidStore();
      const state = entry.state;
      if (
        state !== "pending" &&
        state !== "ready" &&
        state !== "retiring"
      ) {
        throw invalidStore();
      }
      if (
        (state === "ready" && !hasHappySessionId) ||
        (state === "pending" && hasHappySessionId) ||
        (state !== "retiring" && (hasConversationId || hasAgentSessionId))
      ) {
        throw invalidStore();
      }
      if (
        state === "retiring" &&
        (typeof entry.providerRetired !== "boolean" || typeof entry.blockRevival !== "boolean")
      ) {
        throw invalidStore();
      }
      const binding = {
        state,
        relayTag: validateRelayTag(entry.relayTag),
        key: decodeCanonicalBase64(entry.key, SESSION_KEY_BYTES),
        ...(state === "retiring"
          ? {
              blockRevival: entry.blockRevival,
              providerRetired: entry.providerRetired,
              ...(hasConversationId
                ? { conversationId: validateSessionId(entry.conversationId) }
                : {}),
              ...(hasAgentSessionId
                ? { agentSessionId: validateAgentSessionId(entry.agentSessionId) }
                : {}),
            }
          : {}),
      };
      if (hasHappySessionId) {
        binding.happySessionId = validateRelaySessionId(entry.happySessionId);
      }
      entries.set(sessionId, binding);
    }
  } catch (error) {
    throw invalidStore(error);
  }
  return entries;
}

function decryptDocument(document, machineKey) {
  try {
    if (
      !isRecord(document) ||
      document.version !== STORE_VERSION ||
      !isRecord(document.kdf) ||
      document.kdf.name !== "HKDF-SHA256" ||
      !isRecord(document.aead) ||
      document.aead.name !== "AES-256-GCM"
    ) {
      throw invalidStore();
    }

    const salt = decodeCanonicalBase64(document.kdf.salt, SALT_BYTES);
    const iv = decodeCanonicalBase64(document.aead.iv, IV_BYTES);
    const tag = decodeCanonicalBase64(document.aead.tag, AUTH_TAG_BYTES);
    const ciphertext = decodeCanonicalBase64(document.aead.ciphertext);
    const kek = deriveKek(machineKey, salt);
    let plaintext;
    try {
      const decipher = createDecipheriv("aes-256-gcm", kek, iv, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(FILE_AAD);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } finally {
      kek.fill(0);
    }

    try {
      return parsePayload(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    throw invalidStore(error);
  }
}

function encryptEntries(entries, machineKey) {
  if (entries.size > MAX_ENTRIES) {
    throw new RangeError(`Happy session key store supports at most ${MAX_ENTRIES} entries`);
  }
  const plaintext = Buffer.from(
    JSON.stringify({
      version: PAYLOAD_VERSION,
      entries: [...entries].map(([sessionId, binding]) => ({
        sessionId,
        state: binding.state,
        relayTag: binding.relayTag,
        key: binding.key.toString("base64"),
        ...(binding.state === "retiring"
          ? {
              blockRevival: binding.blockRevival,
              providerRetired: binding.providerRetired,
              ...(typeof binding.conversationId === "string"
                ? { conversationId: binding.conversationId }
                : {}),
              ...(typeof binding.agentSessionId === "string"
                ? { agentSessionId: binding.agentSessionId }
                : {}),
            }
          : {}),
        ...(typeof binding.happySessionId === "string"
          ? { happySessionId: binding.happySessionId }
          : {}),
      })),
    }),
    "utf8",
  );
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    plaintext.fill(0);
    throw new RangeError("Happy session key store payload is too large");
  }

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kek = deriveKek(machineKey, salt);
  let ciphertext;
  let tag;
  try {
    const cipher = createCipheriv("aes-256-gcm", kek, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(FILE_AAD);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
  } finally {
    plaintext.fill(0);
    kek.fill(0);
  }

  const serialized = JSON.stringify({
    version: STORE_VERSION,
    kdf: { name: "HKDF-SHA256", salt: salt.toString("base64") },
    aead: {
      name: "AES-256-GCM",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_FILE_BYTES) {
    throw new RangeError("Happy session key store file is too large");
  }
  return serialized;
}

async function loadEntries(filePath, machineKey) {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > MAX_STORE_FILE_BYTES ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw invalidStore();
    }
    // Read no more than the size we validated, plus one byte to detect a
    // concurrent append. FileHandle.readFile() could otherwise allocate an
    // attacker-controlled amount if the file grows between stat and read.
    const bytes = Buffer.alloc(metadata.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset === 0 || offset !== metadata.size) {
      throw invalidStore();
    }

    let document;
    try {
      document = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    } catch (error) {
      throw invalidStore(error);
    }
    return decryptDocument(document, machineKey);
  } finally {
    await handle.close();
  }
}

async function writeEntries(filePath, entries, machineKey) {
  const serialized = encryptEntries(entries, machineKey);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${HAPPY_SESSION_KEY_STORE_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    renamed = true;
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function removeStore(filePath) {
  try {
    await unlink(filePath);
    await syncDirectory(path.dirname(filePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function serializeForPath(filePath, operation) {
  const previous = operationQueues.get(filePath) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  operationQueues.set(filePath, settled);
  void settled.then(() => {
    if (operationQueues.get(filePath) === settled) operationQueues.delete(filePath);
  });
  return result;
}

export function createHappySessionKeyStore({ directory, machineKey }) {
  const filePath = resolveStorePath(directory);
  const pairingMachineKey = copyMachineKey(machineKey);

  return Object.freeze({
    filePath,

    async list() {
      return serializeForPath(filePath, async () => {
        const entries = await loadEntries(filePath, pairingMachineKey);
        return entries
          ? [...entries].map(([sessionId, binding]) => ({
              sessionId,
              ...copyBinding(binding),
            }))
          : [];
      });
    },

    async getOrCreate(sessionId, initialRelayTag) {
      validateSessionId(sessionId);
      validateRelayTag(initialRelayTag);
      return serializeForPath(filePath, async () => {
        const entries = (await loadEntries(filePath, pairingMachineKey)) ?? new Map();
        const existing = entries.get(sessionId);
        if (existing) return copyBinding(existing);
        if (entries.size >= MAX_ENTRIES) {
          throw new RangeError(`Happy session key store supports at most ${MAX_ENTRIES} entries`);
        }
        const binding = {
          state: "pending",
          relayTag: initialRelayTag,
          key: randomBytes(SESSION_KEY_BYTES),
        };
        entries.set(sessionId, binding);
        await writeEntries(filePath, entries, pairingMachineKey);
        return copyBinding(binding);
      });
    },

    async replacePendingTag(sessionId, relayTag) {
      validateSessionId(sessionId);
      validateRelayTag(relayTag);
      return serializeForPath(filePath, async () => {
        const entries = await loadEntries(filePath, pairingMachineKey);
        const binding = entries?.get(sessionId);
        if (!binding) throw new Error("Happy session binding does not exist");
        if (binding.state !== "pending") {
          throw new Error("A non-pending Happy session binding cannot change relay tags");
        }
        binding.relayTag = relayTag;
        await writeEntries(filePath, entries, pairingMachineKey);
        return copyBinding(binding);
      });
    },

    async markReady(sessionId, happySessionId) {
      validateSessionId(sessionId);
      validateRelaySessionId(happySessionId);
      return serializeForPath(filePath, async () => {
        const entries = await loadEntries(filePath, pairingMachineKey);
        const binding = entries?.get(sessionId);
        if (!binding) throw new Error("Happy session binding does not exist");
        if (binding.state === "retiring") {
          throw new Error("A retiring Happy session binding cannot become ready");
        }
        if (binding.state === "ready") {
          if (binding.happySessionId !== happySessionId) {
            throw new Error("Happy session binding resolved to a different relay row");
          }
          return copyBinding(binding);
        }
        binding.state = "ready";
        binding.happySessionId = happySessionId;
        await writeEntries(filePath, entries, pairingMachineKey);
        return copyBinding(binding);
      });
    },

    async markRetiring(
      sessionId,
      happySessionId,
      providerRetired = false,
      blockRevival = false,
      conversationId,
      agentSessionId,
    ) {
      validateSessionId(sessionId);
      if (happySessionId !== undefined) validateRelaySessionId(happySessionId);
      if (typeof providerRetired !== "boolean") {
        throw new TypeError("Happy provider retirement state must be a boolean");
      }
      if (typeof blockRevival !== "boolean") {
        throw new TypeError("Happy revival-block state must be a boolean");
      }
      if (conversationId !== undefined) validateSessionId(conversationId);
      if (agentSessionId !== undefined) validateAgentSessionId(agentSessionId);
      return serializeForPath(filePath, async () => {
        const entries = await loadEntries(filePath, pairingMachineKey);
        const binding = entries?.get(sessionId);
        if (!binding) throw new Error("Happy session binding does not exist");
        if (
          typeof binding.happySessionId === "string" &&
          happySessionId !== undefined &&
          binding.happySessionId !== happySessionId
        ) {
          throw new Error("Happy session binding resolved to a different relay row");
        }
        if (
          typeof binding.conversationId === "string" &&
          conversationId !== undefined &&
          binding.conversationId !== conversationId
        ) {
          throw new Error("Happy session binding resolved to a different conversation");
        }
        if (
          typeof binding.agentSessionId === "string" &&
          agentSessionId !== undefined &&
          binding.agentSessionId !== agentSessionId
        ) {
          throw new Error("Happy session binding resolved to a different agent session");
        }
        binding.state = "retiring";
        binding.providerRetired = binding.providerRetired === true || providerRetired;
        binding.blockRevival = binding.blockRevival === true || blockRevival;
        if (happySessionId !== undefined) binding.happySessionId = happySessionId;
        if (conversationId !== undefined) binding.conversationId = conversationId;
        if (agentSessionId !== undefined) binding.agentSessionId = agentSessionId;
        await writeEntries(filePath, entries, pairingMachineKey);
        return copyBinding(binding);
      });
    },

    async delete(sessionId) {
      validateSessionId(sessionId);
      return serializeForPath(filePath, async () => {
        const entries = await loadEntries(filePath, pairingMachineKey);
        if (!entries || !entries.delete(sessionId)) return false;
        if (entries.size === 0) await removeStore(filePath);
        else await writeEntries(filePath, entries, pairingMachineKey);
        return true;
      });
    },
  });
}
