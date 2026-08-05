// ABOUTME: Inspects and rotates the persistent Seren Desktop automation key.
// ABOUTME: Reconciles stored key scopes with the least-privilege scopes required by this build.

import {
  type ApiKeyCreated,
  type ApiKeyInfo,
  type ApiKeyType,
  createDefaultOrgApiKey,
  listDefaultOrgApiKeys,
  revokeDefaultOrgApiKey,
} from "@/api";
import {
  getSerenApiKey,
  getSerenSkillApiKey,
  storeSerenApiKey,
  storeSerenSkillApiKey,
} from "@/lib/tauri-bridge";

export const DESKTOP_API_KEY_NAME = "Seren Desktop";
export const SKILL_API_KEY_NAME = "Seren Desktop Skills";

/**
 * Skill child processes and the SerenDB data plane only ever invoke
 * publishers. They receive this key instead of the Desktop key so that the
 * publisher-administration scopes below — which are safe on the Desktop key
 * because every mutation there is approval-gated on the MCP dispatch path —
 * are never exported into a process that can call the REST API directly.
 * See #3675.
 */
export const SKILL_API_KEY_SCOPES = ["publisher:*"] as const;
export const DESKTOP_API_KEY_SCOPES = [
  "publisher:*",
  "managed-deployment:update",
  "managed-deployment:stop",
  "managed-deployment:delete",
  "organization:read",
  "publisher-definition:read",
  "publisher-definition:create",
  "publisher-definition:update",
  "publisher-pricing:update",
  "oauth-provider:read",
  "oauth-provider:create",
  "oauth-provider:update",
  "oauth-connection:read",
] as const;

export interface CreateApiKeyOptions {
  name?: string;
  keyType?: ApiKeyType;
  agentIdentityId?: string;
  scopes?: readonly string[];
}

export type DesktopApiKeyState =
  | "current"
  | "missing"
  | "unrecognized"
  | "revoked"
  | "expired"
  | "outdated";

export interface DesktopApiKeyStatus {
  state: DesktopApiKeyState;
  key: ApiKeyInfo | null;
  maskedValue: string | null;
  currentScopes: string[];
  requiredScopes: string[];
  missingScopes: string[];
  unexpectedScopes: string[];
  needsRepair: boolean;
}

export interface DesktopApiKeyRepairResult {
  status: DesktopApiKeyStatus;
  revokedPreviousKey: boolean;
  warning: string | null;
}

/**
 * Thrown when provisioning the Seren Desktop API key fails. Carries the HTTP
 * status so the auth store can distinguish terminal auth failures from
 * retryable network/server failures. See #2497 and #3520.
 */
export class ApiKeyProvisioningError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiKeyProvisioningError";
    this.status = status;
  }
}

function responseStatus(response: Response | undefined): number | undefined {
  return typeof response?.status === "number" ? response.status : undefined;
}

async function apiKeyRequestError(
  fallback: string,
  response: Response | undefined,
): Promise<ApiKeyProvisioningError> {
  const status = responseStatus(response);
  let message = fallback;
  try {
    const parsed = (await response?.clone().json()) as { message?: unknown };
    if (typeof parsed?.message === "string") message = parsed.message;
  } catch {
    // Non-JSON body — retain the safe fallback.
  }
  const statusSuffix =
    typeof status === "number" ? ` (returned HTTP ${status})` : "";
  return new ApiKeyProvisioningError(`${message}${statusSuffix}`, status);
}

async function createApiKeyRecord(
  options: CreateApiKeyOptions = {},
): Promise<ApiKeyCreated> {
  const { data, error, response } = await createDefaultOrgApiKey({
    body: {
      name: options.name ?? DESKTOP_API_KEY_NAME,
      key_type: options.keyType,
      agent_identity_id: options.agentIdentityId,
      scopes: options.scopes
        ? [...options.scopes]
        : [...DESKTOP_API_KEY_SCOPES],
    },
    throwOnError: false,
  });

  if (error || !data?.data) {
    throw await apiKeyRequestError("Failed to create API key", response);
  }

  return data.data;
}

/**
 * Create an API key for MCP authentication. Caller-supplied scope overrides
 * remain supported; Desktop's default stays the exact required scope set.
 */
export async function createApiKey(
  options: CreateApiKeyOptions = {},
): Promise<string> {
  return (await createApiKeyRecord(options)).api_key;
}

function publicKeyId(storedKey: string): string | null {
  return /^seren_([^_]+)_/.exec(storedKey)?.[1] ?? null;
}

function maskedKeyPrefix(key: ApiKeyInfo): string {
  return `${key.key_prefix}••••••••`;
}

function requiredScopesMissing(scopes: readonly string[]): string[] {
  const current = new Set(scopes);
  return DESKTOP_API_KEY_SCOPES.filter((scope) => !current.has(scope));
}

function statusFromRecord(key: ApiKeyInfo): DesktopApiKeyStatus {
  const currentScopes = [...(key.scopes ?? [])];
  const missingScopes = requiredScopesMissing(currentScopes);
  const required = new Set<string>(DESKTOP_API_KEY_SCOPES);
  const unexpectedScopes = currentScopes.filter(
    (scope) => !required.has(scope),
  );
  const expired =
    key.expires_at !== null &&
    key.expires_at !== undefined &&
    new Date(key.expires_at).getTime() <= Date.now();
  const state: DesktopApiKeyState = key.revoked_at
    ? "revoked"
    : expired
      ? "expired"
      : missingScopes.length > 0 || unexpectedScopes.length > 0
        ? "outdated"
        : "current";

  return {
    state,
    key,
    maskedValue: maskedKeyPrefix(key),
    currentScopes,
    requiredScopes: [...DESKTOP_API_KEY_SCOPES],
    missingScopes,
    unexpectedScopes,
    needsRepair: state !== "current",
  };
}

function missingStatus(state: "missing" | "unrecognized"): DesktopApiKeyStatus {
  return {
    state,
    key: null,
    maskedValue: null,
    currentScopes: [],
    requiredScopes: [...DESKTOP_API_KEY_SCOPES],
    missingScopes: [...DESKTOP_API_KEY_SCOPES],
    unexpectedScopes: [],
    needsRepair: true,
  };
}

/**
 * Inspect the exact key stored by Desktop. The raw secret never leaves this
 * service; the Settings surface receives only Core's non-secret list record.
 */
export async function getDesktopApiKeyStatus(
  storedKey?: string | null,
): Promise<DesktopApiKeyStatus> {
  const rawKey = storedKey === undefined ? await getSerenApiKey() : storedKey;
  if (!rawKey) return missingStatus("missing");

  const keyId = publicKeyId(rawKey);
  if (!keyId) return missingStatus("unrecognized");

  const { data, error, response } = await listDefaultOrgApiKeys({
    throwOnError: false,
  });
  if (error || !data?.data) {
    throw await apiKeyRequestError("Failed to inspect API key", response);
  }

  const record = data.data.find((candidate) => candidate.key_id === keyId);
  return record ? statusFromRecord(record) : missingStatus("unrecognized");
}

function statusFromCreated(created: ApiKeyCreated): DesktopApiKeyStatus {
  return statusFromRecord({
    created_at: created.created_at,
    expires_at: created.expires_at,
    id: created.id,
    key_id: created.key_id,
    key_prefix: `seren_${created.key_id}_`,
    key_type: created.key_type,
    last_used_at: null,
    name: created.name,
    organization_id: created.organization_id,
    revoked_at: null,
    scopes: created.scopes,
  });
}

async function revokeKeyRecord(key: ApiKeyInfo | ApiKeyCreated): Promise<void> {
  const { error, response } = await revokeDefaultOrgApiKey({
    // Despite its generated name, Core's route requires the record UUID (`id`),
    // not the short public `key_id`. The Rust lease manager pins this contract.
    path: { key_id: key.id },
    throwOnError: false,
  });
  if (error || (response && !response.ok)) {
    throw await apiKeyRequestError("Failed to revoke API key", response);
  }
}

let repairInFlight: Promise<DesktopApiKeyRepairResult> | null = null;

/**
 * Rotate the Desktop automation key to this build's exact least-privilege
 * scope set. The replacement is stored before the prior record is revoked so
 * a transient revoke failure cannot strand Desktop without a usable key.
 */
export function repairDesktopApiKey(
  inspectedStatus?: DesktopApiKeyStatus,
): Promise<DesktopApiKeyRepairResult> {
  if (repairInFlight) return repairInFlight;

  repairInFlight = (async () => {
    const previous = inspectedStatus ?? (await getDesktopApiKeyStatus());
    const created = await createApiKeyRecord();

    try {
      await storeSerenApiKey(created.api_key);
    } catch (error) {
      // Best effort: do not leave a server-side key orphaned if local secure
      // storage rejects the replacement.
      await revokeKeyRecord(created).catch(() => undefined);
      throw error;
    }

    let revokedPreviousKey = false;
    let warning: string | null = null;
    if (previous.key && !previous.key.revoked_at) {
      try {
        await revokeKeyRecord(previous.key);
        revokedPreviousKey = true;
      } catch {
        // The replacement is already active and stored. Report the cleanup
        // failure without rolling back to an outdated or revoked credential.
        warning =
          "The replacement key is active, but the previous key could not be revoked.";
      }
    }

    return {
      status: statusFromCreated(created),
      revokedPreviousKey,
      warning,
    };
  })().finally(() => {
    repairInFlight = null;
  });

  return repairInFlight;
}

async function skillKeyNeedsReplacement(storedKey: string): Promise<boolean> {
  const keyId = publicKeyId(storedKey);
  if (!keyId) return true;

  const { data, error, response } = await listDefaultOrgApiKeys({
    throwOnError: false,
  });
  if (error || !data?.data) {
    throw await apiKeyRequestError("Failed to inspect skill API key", response);
  }

  const record = data.data.find((candidate) => candidate.key_id === keyId);
  if (!record || record.revoked_at) return true;
  if (
    record.expires_at !== null &&
    record.expires_at !== undefined &&
    new Date(record.expires_at).getTime() <= Date.now()
  ) {
    return true;
  }

  const scopes = new Set(record.scopes ?? []);
  const required = new Set<string>(SKILL_API_KEY_SCOPES);
  return (
    scopes.size !== required.size ||
    [...required].some((scope) => !scopes.has(scope))
  );
}

let skillKeyInFlight: Promise<void> | null = null;

/**
 * Provision the publisher-invocation-only key that skill child processes and
 * the SerenDB data plane receive. Reconciled the same way as the Desktop key so
 * a key minted by an older build cannot linger with broader scopes.
 *
 * `isCurrent` lets the caller invalidate the provisioning mid-flight: a
 * sign-out (or account switch) that lands between the server-side create and
 * the local store must not write the old session's live key into the keychain
 * of whoever is signed in next. When it reports stale, the created key is
 * revoked instead of stored. #3696.
 */
export function ensureSkillApiKey(options?: {
  isCurrent?: () => boolean;
}): Promise<void> {
  if (skillKeyInFlight) return skillKeyInFlight;
  const isCurrent = options?.isCurrent ?? (() => true);

  skillKeyInFlight = (async () => {
    const existing = await getSerenSkillApiKey();
    if (existing && !(await skillKeyNeedsReplacement(existing))) return;

    const previousKeyId = existing ? publicKeyId(existing) : null;
    const created = await createApiKeyRecord({
      name: SKILL_API_KEY_NAME,
      scopes: SKILL_API_KEY_SCOPES,
    });
    if (!isCurrent()) {
      await revokeKeyRecord(created).catch(() => undefined);
      return;
    }
    try {
      // Store before revoking so a failed revoke cannot strand skills without
      // a usable key, matching repairDesktopApiKey.
      await storeSerenSkillApiKey(created.api_key);
    } catch (error) {
      // Do not leave a server-side key orphaned if local secure storage
      // rejects it — every refresh would mint another live key. #3694.
      await revokeKeyRecord(created).catch(() => undefined);
      throw error;
    }

    if (previousKeyId) {
      const { data } = await listDefaultOrgApiKeys({ throwOnError: false });
      const stale = data?.data?.find(
        (candidate) =>
          candidate.key_id === previousKeyId && !candidate.revoked_at,
      );
      if (stale) {
        await revokeKeyRecord(stale).catch((error) => {
          console.warn(
            "[Desktop API Access] Stale skill key revoke failed; the old key stays active server-side:",
            error,
          );
        });
      }
    }
  })().finally(() => {
    skillKeyInFlight = null;
  });

  return skillKeyInFlight;
}
