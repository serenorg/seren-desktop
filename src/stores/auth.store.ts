// ABOUTME: Reactive store for authentication state management.
// ABOUTME: Tracks user session and installs runtime-specific auth bindings lazily.

import { createStore } from "solid-js/store";
import { addSerenDbServer, removeSerenDbServer } from "@/lib/mcp/serendb";
import { runtimeHasCapability } from "@/lib/runtime";
import {
  clearSerenApiKey,
  getSerenApiKey,
  isTauriRuntime,
  storeSerenApiKey,
} from "@/lib/tauri-bridge";
import {
  logout as authLogout,
  createApiKey,
  isLoggedIn,
} from "@/services/auth";
import { initializeGateway, resetGateway } from "@/services/mcp-gateway";
import {
  getDefaultOrganizationPrivateChatPolicy,
  type OrganizationPrivateChatPolicy,
} from "@/services/organization-policy";

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
  privateChatPolicy: OrganizationPrivateChatPolicy | null;
  /**
   * Set true when something asks for the user-visible sign-in modal —
   * mid-session expiry, a `/login` slash command, refresh-token failure.
   * The layout-level <SessionExpiredModal /> subscribes to this signal and
   * shows the blocking modal. Distinct from `isAuthenticated` so we can
   * tell "user is signed out" (passive titlebar button) apart from
   * "user needs to know they're signed out RIGHT NOW" (modal).
   * See #1661.
   */
  signInModalRequested: boolean;
}

const [state, setState] = createStore<AuthState>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  mcpConnected: false,
  privateChatPolicy: null,
  signInModalRequested: false,
});

let authBindingsInitialized = false;

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
  if (!runtimeHasCapability("localMcp")) {
    setState("mcpConnected", false);
    return;
  }

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

async function loadPrivateChatPolicy(): Promise<void> {
  try {
    const policy = await getDefaultOrganizationPrivateChatPolicy();
    setState("privateChatPolicy", policy);
  } catch (error) {
    console.warn("[Auth Store] Failed to load private chat policy:", error);
    setState("privateChatPolicy", null);
  }
}

/**
 * Check authentication status on app startup.
 * Provisions the SerenDB API key before flipping `isAuthenticated` so every
 * downstream consumer (Claude memory interceptor, private models, catalog,
 * skills) sees a ready state atomically — see #1613.
 */
export async function checkAuth(): Promise<void> {
  setState("isLoading", true);
  try {
    const authenticated = await isLoggedIn();

    if (!authenticated) {
      setState("isAuthenticated", false);
      return;
    }

    await loadPrivateChatPolicy();

    const hasApiKey = await ensureApiKey();
    if (!hasApiKey) {
      console.warn("[Auth Store] Could not ensure API key - MCP may not work");
    }

    setState("isAuthenticated", true);

    // Initialize MCP Gateway in background (non-blocking)
    void initializeMcpInBackground();
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Set user as authenticated after successful login.
 * Provisions the SerenDB API key before flipping `isAuthenticated` so every
 * downstream consumer (Claude memory interceptor, private models, catalog,
 * skills) sees a ready state atomically — see #1613. The loading spinner
 * covers the extra `createApiKey` round-trip so the user never sees a logged-in
 * shell without its credentials.
 */
export async function setAuthenticated(user: User): Promise<void> {
  setState("isLoading", true);
  try {
    await loadPrivateChatPolicy();

    const hasApiKey = await ensureApiKey();
    if (!hasApiKey) {
      console.warn(
        "[Auth Store] Could not ensure API key after login - MCP may not work",
      );
    }

    setState({
      user,
      isAuthenticated: true,
    });

    // Initialize MCP Gateway in background (non-blocking)
    void initializeMcpInBackground();
  } finally {
    setState("isLoading", false);
  }
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
    privateChatPolicy: null,
  });
}

/**
 * Pure state mutation: clear the user, isAuthenticated, and privateChatPolicy
 * fields. Does NOT show any UI. Use this when you've decided the auth state
 * is no longer valid (refresh failed, IPC told us tokens died, /login slash
 * command). If you also want the user to know they need to sign in right now,
 * call `requestSignInModal()` separately.
 *
 * Renamed from `promptLogin` (which lied — it never prompted anything;
 * see #1661).
 */
export function clearAuthState(): void {
  setState({
    isAuthenticated: false,
    user: null,
    privateChatPolicy: null,
  });
}

/**
 * Ask the layout-level <SessionExpiredModal /> to show. Pure UI signal —
 * does NOT touch auth state. Pair with `clearAuthState()` when you also
 * need to invalidate the session. See #1661.
 */
export function requestSignInModal(): void {
  setState("signInModalRequested", true);
}

/**
 * Hide the session-expired modal. Called when the user successfully signs
 * in (or explicitly dismisses).
 */
export function dismissSignInModal(): void {
  setState("signInModalRequested", false);
}

// Listen for session-expired events from the desktop runtime (both tokens
// dead, or backend explicitly told us to re-auth). The Rust side already
// cleared its own state; we mirror that into the frontend store AND raise
// the modal so the user gets visible escalation instead of just a passive
// titlebar button. See #1661.
export async function initAuthRuntimeBindings(): Promise<void> {
  if (authBindingsInitialized || !isTauriRuntime()) {
    return;
  }

  authBindingsInitialized = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen("auth:session-expired", () => {
    console.warn("[Auth Store] Session expired event from backend");
    clearAuthState();
    requestSignInModal();
  });
}

export const authStore = state;
