// ABOUTME: Reactive store for authentication state management.
// ABOUTME: Tracks user session and provides login/logout actions.

import { createStore } from "solid-js/store";
import { isLoggedIn, logout as authLogout } from "@/services/auth";

export interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

const [state, setState] = createStore<AuthState>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
});

/**
 * Check authentication status on app startup.
 */
export async function checkAuth(): Promise<void> {
  setState("isLoading", true);
  try {
    const authenticated = await isLoggedIn();
    setState("isAuthenticated", authenticated);
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Set user as authenticated after successful login.
 */
export function setAuthenticated(user: User): void {
  setState({
    user,
    isAuthenticated: true,
    isLoading: false,
  });
}

/**
 * Log out and clear authentication state.
 */
export async function logout(): Promise<void> {
  await authLogout();
  setState({
    user: null,
    isAuthenticated: false,
    isLoading: false,
  });
}

export const authStore = state;
