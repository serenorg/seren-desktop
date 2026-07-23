// ABOUTME: Authentication service for login, logout, and token management.
// ABOUTME: Wraps the generated seren-core SDK with token storage and rate-limit policy.

import {
  type ApiKeyType,
  createDefaultOrgApiKey,
  getCurrentUser,
  type LoginResult,
  login as loginSdk,
  refreshToken as refreshTokenSdk,
} from "@/api";
import {
  clearDefaultOrganizationId,
  clearRefreshToken,
  clearToken,
  getRefreshToken,
  getToken,
  isTauriRuntime,
  storeDefaultOrganizationId,
  storeRefreshToken,
  storeToken,
} from "@/lib/tauri-bridge";
import { revokeAllCredentialLeases } from "@/services/credential-lease";
import { clearAuthState, requestSignInModal } from "@/stores/auth.store";

export type { LoginResult };

export interface AuthError {
  message: string;
  code?: string;
}

interface RefreshAccessTokenOptions {
  promptOnFailure?: boolean;
}

type RefreshAccessTokenOutcome =
  | "success"
  | "terminal-failure"
  | "transient-failure"
  | "unauthenticated";

let refreshAccessTokenInFlight: Promise<RefreshAccessTokenOutcome> | null =
  null;

// Client-side login rate limiting (exponential backoff)
const loginRateLimit = {
  attempts: 0,
  lastAttemptTime: 0,
  backoffMs: 1_000,
};
const MAX_LOGIN_ATTEMPTS = 5;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 30_000;

function checkLoginRateLimit(): void {
  const now = Date.now();
  const elapsed = now - loginRateLimit.lastAttemptTime;

  if (
    loginRateLimit.attempts >= MAX_LOGIN_ATTEMPTS &&
    elapsed < loginRateLimit.backoffMs
  ) {
    const waitSeconds = Math.ceil((loginRateLimit.backoffMs - elapsed) / 1000);
    throw new Error(
      `Too many login attempts. Please wait ${waitSeconds} seconds.`,
    );
  }

  // Reset after sufficient cooldown
  if (elapsed > loginRateLimit.backoffMs * 2) {
    loginRateLimit.attempts = 0;
    loginRateLimit.backoffMs = 1_000;
  }
}

function recordLoginAttempt(success: boolean): void {
  loginRateLimit.attempts++;
  loginRateLimit.lastAttemptTime = Date.now();

  if (success) {
    loginRateLimit.attempts = 0;
    loginRateLimit.backoffMs = 1_000;
  } else {
    loginRateLimit.backoffMs = Math.min(
      loginRateLimit.backoffMs * BACKOFF_MULTIPLIER,
      MAX_BACKOFF_MS,
    );
  }
}

/**
 * Login with email and password.
 * Stores token securely on success.
 * @throws Error on authentication failure or rate limiting
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  checkLoginRateLimit();

  const { data, error, response } = await loginSdk({
    body: { email, password },
    throwOnError: false,
  });

  if (error || !data?.data) {
    recordLoginAttempt(false);
    if (response?.status === 401) {
      throw new Error("Invalid email or password");
    }
    let message = "Authentication failed";
    try {
      const parsed = (await response?.clone().json()) as Partial<AuthError>;
      if (typeof parsed?.message === "string") {
        message = parsed.message;
      }
    } catch {
      // Non-JSON body — fall back to default message.
    }
    throw new Error(message);
  }

  recordLoginAttempt(true);
  await storeToken(data.data.access_token);
  await storeRefreshToken(data.data.refresh_token);
  await storeDefaultOrganizationId(data.data.default_organization_id);
  return data.data;
}

/**
 * Logout and clear stored tokens.
 */
export async function logout(): Promise<void> {
  // Revoke while the Rust manager can still authenticate the API request.
  // It drops local lease access before its remote call and retains only a
  // non-secret retry record if the network is unavailable. Token clearing must
  // still complete on a remote failure so logout cannot leave credentials live.
  try {
    await revokeAllCredentialLeases();
  } catch (error) {
    console.warn(
      "Failed to revoke session credential leases during logout:",
      error,
    );
  }
  await clearToken();
  await clearRefreshToken();
  await clearDefaultOrganizationId();
}

/**
 * Refresh the access token using the stored refresh token.
 * @returns true if refresh succeeded, false if refresh token is missing or invalid
 */
export async function refreshAccessToken(
  options: RefreshAccessTokenOptions = {},
): Promise<boolean> {
  const { promptOnFailure = true } = options;
  if (!refreshAccessTokenInFlight) {
    refreshAccessTokenInFlight = performRefreshAccessToken().finally(() => {
      refreshAccessTokenInFlight = null;
    });
  }

  const outcome = await refreshAccessTokenInFlight;
  if (outcome === "terminal-failure") {
    // A real session existed and the refresh token was rejected — escalate.
    clearAuthState();
    if (promptOnFailure) {
      requestSignInModal();
    }
  } else if (outcome === "unauthenticated") {
    // No refresh token means never-signed-in or already-logged-out, not
    // session expiry. Clear any stale frontend state but NEVER raise the
    // "session expired" modal — otherwise every signed-out Gateway 401 pops a
    // spurious sign-in prompt. Mirrors the Rust-side guard in auth.rs (#1860).
    clearAuthState();
  }

  return outcome === "success";
}

async function performRefreshAccessToken(): Promise<RefreshAccessTokenOutcome> {
  // With no refresh token there is no session to refresh — this is
  // never-signed-in or already-logged-out, not an expired session. Surface it
  // distinctly so the caller never raises the "session expired" modal for a
  // signed-out user (the Rust side already makes this distinction; see #1860).
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    return "unauthenticated";
  }

  if (isTauriRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const refreshed = await invoke<boolean>("refresh_session");
      return refreshed ? "success" : "terminal-failure";
    } catch {
      // Network/IPC errors should not clear credentials or force a sign-in.
      return "transient-failure";
    }
  }

  try {
    const { data, error, response } = await refreshTokenSdk({
      body: { refresh_token: refreshToken },
      throwOnError: false,
    });

    if (error || !data?.data) {
      // 401: refresh token is invalid, expired, or reused.
      if (response?.status === 401) {
        await clearToken();
        await clearRefreshToken();
        return "terminal-failure";
      }
      return "transient-failure";
    }

    await storeToken(data.data.access_token);
    if (data.data.refresh_token) {
      await storeRefreshToken(data.data.refresh_token);
    }
    return "success";
  } catch {
    // Network error - don't clear tokens, don't prompt login
    return "transient-failure";
  }
}

/**
 * Check if user is logged in (has stored token).
 * Only checks local storage, does not validate with server.
 */
export async function hasStoredToken(): Promise<boolean> {
  const token = await getToken();
  return token !== null;
}

/**
 * Validate token with the server by calling /auth/me.
 * Clears token if invalid/expired.
 * @returns true if token is valid, false otherwise
 */
export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  if (!token) {
    return false;
  }

  try {
    const { data, error, response } = await getCurrentUser({
      throwOnError: false,
    });

    if (data?.data) {
      return true;
    }

    if (response?.status === 401 && (await getRefreshToken())) {
      const refreshed = await refreshAccessToken({ promptOnFailure: false });
      if (refreshed) {
        const { data: retryData } = await getCurrentUser({
          throwOnError: false,
        });
        if (retryData?.data) {
          return true;
        }
      }
    }

    if (error) {
      await clearToken();
    }
    return false;
  } catch {
    // Network error - assume token might still be valid (offline usage).
    return true;
  }
}

/**
 * Get stored authentication token.
 * Returns null if not logged in.
 */
export { getToken };

const DESKTOP_API_KEY_NAME = "Seren Desktop";
const DESKTOP_API_KEY_SCOPES = ["publisher:*"] as const;

export interface CreateApiKeyOptions {
  name?: string;
  keyType?: ApiKeyType;
  agentIdentityId?: string;
  scopes?: readonly string[];
}

/**
 * Thrown when provisioning the SerenDB desktop API key fails. Carries the HTTP
 * `status` so the auth store can distinguish a non-transient auth/permission
 * failure (401/403 → re-sign-in) from a retryable one (5xx/network → keep the
 * session, chat still works on the JWT). See #2497.
 */
export class ApiKeyProvisioningError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiKeyProvisioningError";
    this.status = status;
  }
}

/**
 * Create a new API key for MCP authentication.
 * Uses POST /organizations/default/api-keys, which resolves "default" to
 * the user's first organization.
 * @returns API key (seren_xxx_yyy format)
 * @throws ApiKeyProvisioningError if not authenticated or the request fails
 */
export async function createApiKey(
  options: CreateApiKeyOptions = {},
): Promise<string> {
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
    const status = response?.status;
    let message = "Failed to create API key";
    try {
      const parsed = (await response?.clone().json()) as Partial<AuthError>;
      if (typeof parsed?.message === "string") {
        message = parsed.message;
      }
    } catch {
      // Non-JSON body — fall back to default message.
    }
    // Carry the HTTP status both as a property (so callers can branch on
    // 401/403 vs 5xx without regex) and in the message via the same
    // `returned HTTP <status>` marker App.tsx already parses. Without this,
    // downstream telemetry/dialogs can't tell a non-transient auth/permission
    // failure from a retryable one. #2497.
    const statusSuffix =
      typeof status === "number" ? ` (returned HTTP ${status})` : "";
    throw new ApiKeyProvisioningError(`${message}${statusSuffix}`, status);
  }

  return data.data.api_key;
}
