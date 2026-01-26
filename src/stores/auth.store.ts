// ABOUTME: Reactive store for authentication state management.
// ABOUTME: Tracks user session and provides login/logout actions.

import { createStore } from "solid-js/store";
import { addSerenDbServer, removeSerenDbServer } from "@/lib/mcp/serendb";
import { logout as authLogout, isLoggedIn } from "@/services/auth";
import { getToken } from "@/lib/tauri-bridge";

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
 * If authenticated, ensures SerenDB MCP server is configured.
 */
export async function checkAuth(): Promise<void> {
  setState("isLoading", true);
  try {
    const authenticated = await isLoggedIn();
    setState("isAuthenticated", authenticated);

    // Ensure SerenDB is configured for authenticated users
    if (authenticated) {
      try {
        const token = await getToken();
        if (token) {
          await addSerenDbServer(token);
        }
      } catch (error) {
        console.error("Failed to add SerenDB MCP server:", error);
      }
    }
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Set user as authenticated after successful login.
 * Also adds SerenDB as the default MCP server.
 */
export async function setAuthenticated(user: User): Promise<void> {
  setState({
    user,
    isAuthenticated: true,
    isLoading: false,
  });

  // Add SerenDB as default MCP server on sign-in
  try {
    const token = await getToken();
    if (token) {
      await addSerenDbServer(token);
    }
  } catch (error) {
    console.error("Failed to add SerenDB MCP server:", error);
  }
}

/**
 * Log out and clear authentication state.
 * Also removes SerenDB MCP server.
 */
export async function logout(): Promise<void> {
  // Remove SerenDB MCP server on sign-out
  try {
    await removeSerenDbServer();
  } catch (error) {
    console.error("Failed to remove SerenDB MCP server:", error);
  }

  await authLogout();
  setState({
    user: null,
    isAuthenticated: false,
    isLoading: false,
  });
}

export const authStore = state;
