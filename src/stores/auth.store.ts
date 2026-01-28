// ABOUTME: Reactive store for authentication state management.
// ABOUTME: Tracks user session, MCP OAuth state, and provides login/logout actions.

import { createStore } from "solid-js/store";
import { addSerenDbServer, removeSerenDbServer } from "@/lib/mcp/serendb";
import { logout as authLogout, isLoggedIn } from "@/services/auth";
import {
  initializeGateway,
  needsMcpAuth,
  resetGateway,
} from "@/services/mcp-gateway";

export interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Whether MCP OAuth is needed (user logged in but no MCP token) */
  needsMcpOAuth: boolean;
  /** Whether MCP Gateway is connected */
  mcpConnected: boolean;
}

const [state, setState] = createStore<AuthState>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  needsMcpOAuth: false,
  mcpConnected: false,
});

/**
 * Check authentication status on app startup.
 * If authenticated, checks MCP OAuth status and initializes the MCP Gateway.
 */
export async function checkAuth(): Promise<void> {
  setState("isLoading", true);
  try {
    const authenticated = await isLoggedIn();
    setState("isAuthenticated", authenticated);

    // Check MCP OAuth status for authenticated users
    if (authenticated) {
      const mcpAuthNeeded = await needsMcpAuth();
      setState("needsMcpOAuth", mcpAuthNeeded);

      if (mcpAuthNeeded) {
        console.log(
          "[Auth Store] MCP OAuth required - user needs to authorize",
        );
        // Don't initialize gateway yet - wait for OAuth
        return;
      }

      // Initialize MCP Gateway for authenticated users with MCP token (non-blocking)
      // Fire and forget - don't block login while tools load
      (async () => {
        try {
          console.log("[Auth Store] Adding Seren MCP server config...");
          await addSerenDbServer();

          console.log("[Auth Store] Initializing MCP Gateway (background)...");
          initializeGateway()
            .then(() => {
              console.log("[Auth Store] MCP Gateway initialized successfully");
              setState("mcpConnected", true);
            })
            .catch((error) => {
              console.error("[Auth Store] MCP Gateway failed:", error);
              // If gateway init fails due to auth, mark as needing OAuth
              if (error?.status === 401) {
                setState("needsMcpOAuth", true);
              }
            });

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
      })();
    }
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Set user as authenticated after successful login.
 * Checks MCP OAuth status and initializes the MCP Gateway if authorized.
 */
export async function setAuthenticated(user: User): Promise<void> {
  // Check MCP OAuth status
  const mcpAuthNeeded = await needsMcpAuth();

  setState({
    user,
    isAuthenticated: true,
    isLoading: false,
    needsMcpOAuth: mcpAuthNeeded,
  });

  if (mcpAuthNeeded) {
    console.log(
      "[Auth Store] setAuthenticated: MCP OAuth required - user needs to authorize",
    );
    // Don't initialize gateway yet - wait for OAuth
    return;
  }

  // Initialize MCP Gateway on sign-in (non-blocking)
  // Fire and forget - don't block UI while tools load
  (async () => {
    try {
      console.log(
        "[Auth Store] setAuthenticated: Adding Seren MCP server config...",
      );
      await addSerenDbServer();

      console.log(
        "[Auth Store] setAuthenticated: Initializing MCP Gateway (background)...",
      );
      initializeGateway()
        .then(() => {
          console.log(
            "[Auth Store] setAuthenticated: MCP Gateway initialized successfully",
          );
          setState("mcpConnected", true);
        })
        .catch((error) => {
          console.error(
            "[Auth Store] setAuthenticated: MCP Gateway failed:",
            error,
          );
          // If gateway init fails due to auth, mark as needing OAuth
          if (error?.status === 401) {
            setState("needsMcpOAuth", true);
          }
        });

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
  })();
}

/**
 * Called when MCP OAuth flow completes successfully.
 * Initializes the MCP Gateway with the new OAuth token.
 */
export async function onMcpOAuthComplete(): Promise<void> {
  console.log("[Auth Store] MCP OAuth completed, initializing gateway...");
  setState("needsMcpOAuth", false);

  // Now initialize the MCP Gateway
  try {
    await addSerenDbServer();

    await initializeGateway();
    console.log("[Auth Store] MCP Gateway initialized after OAuth");
    setState("mcpConnected", true);

    // Trigger auto-connect for local MCP servers
    const { initMcpAutoConnect } = await import("@/lib/mcp/auto-connect");
    const results = await initMcpAutoConnect();
    console.log("[Auth Store] MCP auto-connect results:", results);
  } catch (error) {
    console.error("[Auth Store] Failed to initialize MCP after OAuth:", error);
    // Re-enable OAuth prompt if initialization fails
    if ((error as { status?: number })?.status === 401) {
      setState("needsMcpOAuth", true);
    }
  }
}

/**
 * Dismiss the MCP OAuth prompt (user chose not to connect).
 */
export function dismissMcpOAuth(): void {
  setState("needsMcpOAuth", false);
}

/**
 * Log out and clear authentication state.
 * Cleans up MCP Gateway state and OAuth tokens.
 */
export async function logout(): Promise<void> {
  // Reset MCP Gateway state (clears OAuth tokens)
  await resetGateway();

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
    needsMcpOAuth: false,
    mcpConnected: false,
  });
}

export const authStore = state;
