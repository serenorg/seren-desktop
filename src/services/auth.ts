// ABOUTME: Authentication service for login, logout, and token management.
// ABOUTME: Communicates with Seren Gateway API using /auth/login endpoint.

import { API_BASE } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import {
  storeToken,
  getToken,
  clearToken,
  storeRefreshToken,
  getRefreshToken,
  clearRefreshToken,
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
      organization_id?: string;
    };
  };
}

export interface AuthError {
  message: string;
  code?: string;
}

/**
 * Login with email and password.
 * Stores token securely on success.
 * @throws Error on authentication failure
 */
export async function login(
  email: string,
  password: string
): Promise<LoginResponse> {
  const response = await appFetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Invalid email or password");
    }
    const error: AuthError = await response.json().catch(() => ({
      message: "Authentication failed",
    }));
    throw new Error(error.message);
  }

  const data: LoginResponse = await response.json();
  await storeToken(data.data.access_token);
  await storeRefreshToken(data.data.refresh_token);
  return data;
}

/**
 * Logout and clear stored tokens.
 */
export async function logout(): Promise<void> {
  await clearToken();
  await clearRefreshToken();
}

/**
 * Refresh the access token using the stored refresh token.
 * @returns true if refresh succeeded, false if refresh token is missing or invalid
 */
export async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    return false;
  }

  try {
    // Use appFetch for CORS bypass in Tauri (it skips auto-refresh for /auth/refresh)
    const response = await appFetch(`${API_BASE}/auth/refresh`, {
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
 * Clears token if invalid/expired.
 * @returns true if token is valid, false otherwise
 */
export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  if (!token) {
    return false;
  }

  try {
    const response = await appFetch(`${API_BASE}/auth/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      return true;
    }

    // Token is invalid or expired - clear it
    if (response.status === 401) {
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
