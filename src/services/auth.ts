// ABOUTME: Authentication service for login, logout, and token management.
// ABOUTME: Communicates with Seren Gateway API and uses secure Tauri storage.

import { fetch } from "@tauri-apps/plugin-http";
import { API_BASE } from "@/lib/config";
import { storeToken, getToken, clearToken, isTauriRuntime } from "@/lib/tauri-bridge";

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
}

export interface AuthError {
  message: string;
  code?: string;
}

/**
 * Login with email verification.
 * Stores token securely on success.
 * @throws Error on authentication failure
 */
export async function login(
  email: string,
  password: string
): Promise<LoginResponse> {
  // Use Tauri HTTP plugin for reliable requests, fallback to native fetch for dev
  const fetchFn = isTauriRuntime() ? fetch : globalThis.fetch;

  const response = await fetchFn(`${API_BASE}/auth/verify-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error: AuthError = await response.json().catch(() => ({
      message: "Authentication failed",
    }));
    throw new Error(error.message);
  }

  const data: LoginResponse = await response.json();
  await storeToken(data.token);
  return data;
}

/**
 * Logout and clear stored token.
 */
export async function logout(): Promise<void> {
  await clearToken();
}

/**
 * Check if user is logged in (has stored token).
 */
export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  return token !== null;
}

/**
 * Get stored authentication token.
 * Returns null if not logged in.
 */
export { getToken };
