// ABOUTME: Authentication service for login, logout, and token management.
// ABOUTME: Communicates with Seren Gateway API using /auth/login endpoint.

import { API_BASE } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { storeToken, getToken, clearToken } from "@/lib/tauri-bridge";

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
