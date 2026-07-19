// ABOUTME: Owns the narrow Happy client and hosted-relay pairing adapter.
// ABOUTME: Pairing material crosses the supervisor channel only and is never logged.

import { randomUUID } from "node:crypto";
import os from "node:os";
import { ApiClient, configuration } from "happy/lib";
import nacl from "tweetnacl";

const AUTH_POLL_MS = 1000;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

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
    return {
      token,
      machineId,
      encryption: { type: "legacy", secret: encodeBase64(decrypted) },
    };
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

function machineMetadata(config) {
  return {
    host: config.machineName,
    platform: `${process.platform}-${process.arch}`,
    happyCliVersion: "1.2.0",
    homeDir: os.homedir(),
    happyHomeDir: os.homedir(),
    happyLibDir: "seren-desktop",
  };
}

export function createHappyLayer({ config, supervisorChannel, debugLog = () => {} }) {
  configuration.serverUrl = config.relayUrl;
  let identity = config.machineIdentity;
  let api = null;
  let machineClient = null;
  let pairingPromise = null;

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
    machineClient.connect();
    supervisorChannel.notify("status_report", { state: "connected", detail: "Connected" });
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
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, AUTH_POLL_MS));
    }
    debugLog("pairing authorization timed out");
  }

  async function startPairing() {
    if (pairingPromise) return pairingPromise;
    pairingPromise = (async () => {
      const keyPair = nacl.box.keyPair();
      await postAuthRequest(config.relayUrl, keyPair.publicKey);
      const payload = `happy://terminal?${encodeBase64Url(keyPair.publicKey)}`;
      supervisorChannel.notify("pairing_payload", { payload });
      void waitForAuthorization(keyPair).catch((error) => {
        debugLog(`pairing authorization failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
      return payload;
    })();
    return pairingPromise;
  }

  return {
    async start() {
      if (await registerMachine()) return;
      return startPairing();
    },
    startPairing,
    close() {
      machineClient?.shutdown();
      machineClient = null;
      api = null;
    },
  };
}
