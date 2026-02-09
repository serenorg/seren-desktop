// ABOUTME: Reactive store for authentication state management.
// ABOUTME: Tracks user session and provides login/logout actions with unified auth flow.

import { listen } from "@tauri-apps/api/event";
import { createStore } from "solid-js/store";
import { addSerenDbServer, removeSerenDbServer } from "@/lib/mcp/serendb";
import {
  clearSerenApiKey,
  getSerenApiKey,
  storeSerenApiKey,
} from "@/lib/tauri-bridge";
import {
  logout as authLogout,
  createApiKey,
  isLoggedIn,
} from "@/services/auth";
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
  /** Whether MCP Gateway is connected */
  mcpConnected: boolean;
}

const [state, setState] = createStore<AuthState>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  mcpConnected: false,
});

/**
 * Ensure we have a Seren API key for MCP authentication.
 * Checks local storage first, only creates a new key if none stored.
 */
async function ensureApiKey(): Promise<boolean> {
  try {
    // Check if we already have a stored API key
    const existingKey = await getSerenApiKey();
    if (existingKey) {
      console.log("[Auth Store] Using existing stored API key");
      return true;
    }

    // No stored key - create a new one
    console.log("[Auth Store] No stored API key, creating new one...");
    const apiKey = await createApiKey();
    await storeSerenApiKey(apiKey);
    console.log("[Auth Store] API key created and stored successfully");
    return true;
  } catch (error) {
    console.error("[Auth Store] Failed to ensure API key:", error);
    return false;
  }
}

/**
 * Initialize MCP Gateway connection in the background.
 * This uses the stored API key for authentication.
 */
async function initializeMcpInBackground(): Promise<void> {
  try {
    console.log("[Auth Store] Adding Seren MCP server config...");
    await addSerenDbServer();

    console.log("[Auth Store] Initializing MCP Gateway (background)...");
    await initializeGateway();
    console.log("[Auth Store] MCP Gateway initialized successfully");
    setState("mcpConnected", true);

    // Trigger auto-connect for local MCP servers
    const { initMcpAutoConnect } = await import("@/lib/mcp/auto-connect");
    console.log(
      "[Auth Store] Triggering MCP auto-connect for local servers...",
    );
    const results = await initMcpAutoConnect();
    console.log("[Auth Store] MCP auto-connect results:", results);
  } catch (error) {
    console.error("[Auth Store] Failed to initialize MCP:", error);
    setState("mcpConnected", false);
  }
}

/**
 * Check authentication status on app startup.
 * If authenticated, fetches API key (if needed) and initializes MCP Gateway.
 */
export async function checkAuth(): Promise<void> {
  setState("isLoading", true);
  try {
    const authenticated = await isLoggedIn();
    setState("isAuthenticated", authenticated);

    if (authenticated) {
      // Ensure we have an API key for MCP (create if not stored)
      const hasApiKey = await ensureApiKey();
      if (!hasApiKey) {
        console.warn(
          "[Auth Store] Could not ensure API key - MCP may not work",
        );
      }

      // Initialize MCP Gateway in background (non-blocking)
      initializeMcpInBackground();
    }
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Set user as authenticated after successful login.
 * Fetches API key and initializes the MCP Gateway.
 */
export async function setAuthenticated(user: User): Promise<void> {
  setState({
    user,
    isAuthenticated: true,
    isLoading: false,
  });

  // Ensure we have an API key for MCP authentication
  const hasApiKey = await ensureApiKey();
  if (!hasApiKey) {
    console.warn(
      "[Auth Store] Could not ensure API key after login - MCP may not work",
    );
  }

  // Initialize MCP Gateway in background (non-blocking)
  initializeMcpInBackground();
}

/**
 * Log out and clear authentication state.
 * Cleans up MCP Gateway state and stored credentials.
 */
export async function logout(): Promise<void> {
  // Reset MCP Gateway state
  await resetGateway();

  // Clear stored API key
  await clearSerenApiKey();

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
    mcpConnected: false,
  });
}

// Listen for session-expired events from Rust backend (e.g. both tokens dead).
// Sets isAuthenticated = false so the UI shows the sign-in prompt.
listen("auth:session-expired", () => {
  console.warn("[Auth Store] Session expired event from backend");
  setState({ isAuthenticated: false, user: null });
});

export const authStore = state;
