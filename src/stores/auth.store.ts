// ABOUTME: Reactive store for authentication state management.
// ABOUTME: Tracks user session and provides login/logout actions.

import { createStore } from "solid-js/store";
import { addSerenDbServer, removeSerenDbServer } from "@/lib/mcp/serendb";
import { logout as authLogout, isLoggedIn, getApiKey } from "@/services/auth";

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
        console.log("[Auth Store] Fetching API key for MCP...");
        const apiKey = await getApiKey();
        console.log("[Auth Store] API key fetched successfully");

        console.log("[Auth Store] Adding SerenDB MCP server...");
        await addSerenDbServer(apiKey);
        console.log("[Auth Store] SerenDB MCP server added successfully");

        // Trigger auto-connect after adding server
        const { initMcpAutoConnect } = await import("@/lib/mcp/auto-connect");
        console.log("[Auth Store] Triggering MCP auto-connect...");
        const results = await initMcpAutoConnect();
        console.log("[Auth Store] MCP auto-connect results:", results);
      } catch (error) {
        console.error("[Auth Store] Failed to add SerenDB MCP server:", error);
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
    console.log("[Auth Store] setAuthenticated: Fetching API key for MCP...");
    const apiKey = await getApiKey();
    console.log("[Auth Store] setAuthenticated: API key fetched successfully");

    console.log("[Auth Store] setAuthenticated: Adding SerenDB MCP server...");
    await addSerenDbServer(apiKey);
    console.log("[Auth Store] setAuthenticated: SerenDB MCP server added successfully");

    // Trigger auto-connect after adding server
    const { initMcpAutoConnect } = await import("@/lib/mcp/auto-connect");
    console.log("[Auth Store] setAuthenticated: Triggering MCP auto-connect...");
    const results = await initMcpAutoConnect();
    console.log("[Auth Store] setAuthenticated: MCP auto-connect results:", results);
  } catch (error) {
    console.error("[Auth Store] setAuthenticated: Failed to add SerenDB MCP server:", error);
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
