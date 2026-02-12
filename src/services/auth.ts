// ABOUTME: Authentication service for login, logout, and token management.
// ABOUTME: Uses manual fetch for login/refresh (not in OpenAPI spec) and SDK for user info.

import { getCurrentUser } from "@/api";
import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import {
  clearDefaultOrganizationId,
  clearRefreshToken,
  clearToken,
  getRefreshToken,
  getToken,
  storeDefaultOrganizationId,
  storeRefreshToken,
  storeToken,
} from "@/lib/tauri-bridge";

export interface LoginResponse {
  data: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user: {
      id: string;
      email: string;
      name?: string;
    };
    default_organization_id: string;
  };
}

export interface AuthError {
  message: string;
  code?: string;
}

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
 * Note: Login endpoint is not in OpenAPI spec, using manual fetch.
 * @throws Error on authentication failure or rate limiting
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  checkLoginRateLimit();

  const response = await appFetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    recordLoginAttempt(false);
    if (response.status === 401) {
      throw new Error("Invalid email or password");
    }
    const error: AuthError = await response.json().catch(() => ({
      message: "Authentication failed",
    }));
    throw new Error(error.message);
  }

  recordLoginAttempt(true);
  const data: LoginResponse = await response.json();
  await storeToken(data.data.access_token);
  await storeRefreshToken(data.data.refresh_token);
  await storeDefaultOrganizationId(data.data.default_organization_id);
  return data;
}

/**
 * Logout and clear stored tokens.
 */
export async function logout(): Promise<void> {
  await clearToken();
  await clearRefreshToken();
  await clearDefaultOrganizationId();
}

/**
 * Refresh the access token using the stored refresh token.
 * Note: Refresh endpoint is not in OpenAPI spec, using manual fetch.
 * @returns true if refresh succeeded, false if refresh token is missing or invalid
 */
export async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    return false;
  }

  try {
    // Use appFetch for CORS bypass in Tauri (it skips auto-refresh for /auth/refresh)
    const response = await appFetch(`${apiBase}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      // Refresh token is invalid or expired - clear all tokens
      if (response.status === 401) {
        await clearToken();
        await clearRefreshToken();
      }
      return false;
    }

    const data: LoginResponse = await response.json();
    await storeToken(data.data.access_token);
    // Store new refresh token if provided (token rotation)
    if (data.data.refresh_token) {
      await storeRefreshToken(data.data.refresh_token);
    }
    return true;
  } catch {
    // Network error - don't clear tokens
    return false;
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
 * Uses generated SDK for type-safe API calls.
 * Clears token if invalid/expired.
 * @returns true if token is valid, false otherwise
 */
export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  if (!token) {
    return false;
  }

  try {
    const { data, error } = await getCurrentUser({ throwOnError: false });

    if (data?.data) {
      return true;
    }

    // Token is invalid or expired - clear it
    if (error) {
      await clearToken();
    }
    return false;
  } catch {
    // Network error - assume token might still be valid
    // This allows offline usage if token was valid
    return true;
  }
}

/**
 * Get stored authentication token.
 * Returns null if not logged in.
 */
export { getToken };

const DESKTOP_API_KEY_NAME = "Seren Desktop";

interface ApiKeyCreateResponse {
  data: {
    api_key: string;
  };
}

/**
 * Create a new API key for MCP authentication.
 * Uses the convenience route: POST /organizations/default/api-keys
 * which resolves "default" to the user's first organization.
 * @returns API key (seren_xxx_yyy format)
 * @throws Error if not authenticated or request fails
 */
export async function createApiKey(): Promise<string> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await appFetch(`${apiBase}/organizations/default/api-keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: DESKTOP_API_KEY_NAME }),
  });

  if (!response.ok) {
    const error: AuthError = await response.json().catch(() => ({
      message: "Failed to create API key",
    }));
    throw new Error(error.message);
  }

  const data: ApiKeyCreateResponse = await response.json();
  return data.data.api_key;
}
