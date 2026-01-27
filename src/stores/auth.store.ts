// ABOUTME: Reactive store for authentication state management.
// ABOUTME: Tracks user session and provides login/logout actions.

import { createStore } from "solid-js/store";
import { addSerenDbServer, removeSerenDbServer } from "@/lib/mcp/serendb";
import { logout as authLogout, isLoggedIn } from "@/services/auth";
import { initializeGateway, resetGateway } from "@/services/mcp-gateway";

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
 * If authenticated, initializes the MCP Gateway.
 */
export async function checkAuth(): Promise<void> {
  setState("isLoading", true);
  try {
    const authenticated = await isLoggedIn();
    setState("isAuthenticated", authenticated);

    // Initialize MCP Gateway for authenticated users
    if (authenticated) {
      try {
        console.log("[Auth Store] Adding Seren MCP server config...");
        await addSerenDbServer();

        console.log("[Auth Store] Initializing MCP Gateway...");
        await initializeGateway();
        console.log("[Auth Store] MCP Gateway initialized successfully");

        // Trigger auto-connect for local MCP servers
        const { initMcpAutoConnect } = await import("@/lib/mcp/auto-connect");
        console.log(
          "[Auth Store] Triggering MCP auto-connect for local servers...",
        );
        const results = await initMcpAutoConnect();
        console.log("[Auth Store] MCP auto-connect results:", results);
      } catch (error) {
        console.error("[Auth Store] Failed to initialize MCP:", error);
      }
    }
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Set user as authenticated after successful login.
 * Initializes the MCP Gateway.
 */
export async function setAuthenticated(user: User): Promise<void> {
  setState({
    user,
    isAuthenticated: true,
    isLoading: false,
  });

  // Initialize MCP Gateway on sign-in
  try {
    console.log(
      "[Auth Store] setAuthenticated: Adding Seren MCP server config...",
    );
    await addSerenDbServer();

    console.log("[Auth Store] setAuthenticated: Initializing MCP Gateway...");
    await initializeGateway();
    console.log(
      "[Auth Store] setAuthenticated: MCP Gateway initialized successfully",
    );

    // Trigger auto-connect for local MCP servers
    const { initMcpAutoConnect } = await import("@/lib/mcp/auto-connect");
    console.log(
      "[Auth Store] setAuthenticated: Triggering MCP auto-connect...",
    );
    const results = await initMcpAutoConnect();
    console.log(
      "[Auth Store] setAuthenticated: MCP auto-connect results:",
      results,
    );
  } catch (error) {
    console.error(
      "[Auth Store] setAuthenticated: Failed to initialize MCP:",
      error,
    );
  }
}

/**
 * Log out and clear authentication state.
 * Cleans up MCP Gateway state.
 */
export async function logout(): Promise<void> {
  // Reset MCP Gateway state
  resetGateway();

  // Remove Seren MCP server config
  try {
    await removeSerenDbServer();
  } catch (error) {
    console.error("Failed to remove Seren MCP server:", error);
  }

  await authLogout();
  setState({
    user: null,
    isAuthenticated: false,
    isLoading: false,
  });
}

export const authStore = state;
