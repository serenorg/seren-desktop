// ABOUTME: Reactive store for authentication state management.
// ABOUTME: Tracks user session and installs runtime-specific auth bindings lazily.

import { createStore } from "solid-js/store";
import { runtimeHasCapability } from "@/lib/runtime";
import { verboseRuntimeConsole } from "@/lib/runtime-console";
import {
  clearSerenApiKey,
  getSerenApiKey,
  isTauriRuntime,
  storeSerenApiKey,
} from "@/lib/tauri-bridge";
import {
  logout as authLogout,
  createApiKey,
  hasStoredToken,
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
let authEpoch = 0;

/**
 * Outcome of [`ensureApiKey`]. On failure we carry the HTTP `status` (when the
 * server gave one) so the caller can tell a non-transient auth/permission
 * failure (401/403) apart from a retryable one (5xx/network). See #2497.
 */
type EnsureApiKeyResult =
  | { ok: true }
  | { ok: false; status: number | undefined; error: unknown };

/**
 * Ensure we have a Seren API key for MCP authentication.
 * Checks local storage first, only creates a new key if none stored.
 */
export async function ensureApiKey(): Promise<EnsureApiKeyResult> {
  try {
    // Check if we already have a stored API key
    const existingKey = await getSerenApiKey();
    if (existingKey) {
      verboseRuntimeConsole.debug("[Auth Store] Using existing stored API key");
      return { ok: true };
    }

    // No stored key - create a new one
    verboseRuntimeConsole.debug(
      "[Auth Store] No stored API key, creating new one...",
    );
    const apiKey = await createApiKey();
    await storeSerenApiKey(apiKey);
    verboseRuntimeConsole.debug(
      "[Auth Store] API key created and stored successfully",
    );
    return { ok: true };
  } catch (error) {
    console.error("[Auth Store] Failed to ensure API key:", error);
    const status =
      typeof (error as { status?: unknown })?.status === "number"
        ? (error as { status: number }).status
        : undefined;
    return { ok: false, status, error };
  }
}

/**
 * Report an API-key provisioning failure to the support pipeline so persistent
 * failures open a serenorg/seren-core ticket instead of dying in a console log.
 * Non-blocking and best-effort — telemetry must never gate sign-in. #2497.
 */
async function reportApiKeyFailure(
  status: number | undefined,
  error: unknown,
): Promise<void> {
  try {
    const { captureSupportError } = await import("@/lib/support/hook");
    const message = error instanceof Error ? error.message : String(error);
    const stack =
      error instanceof Error && error.stack ? error.stack.split("\n") : [];
    void captureSupportError({
      kind: "auth.api_key_provisioning_failure",
      message,
      stack,
      http: {
        method: "POST",
        url: "https://api.serendb.com/organizations/default/api-keys",
        status,
        body: message,
      },
    });
  } catch (captureErr) {
    console.warn(`[Auth Store] captureSupportError unavailable: ${captureErr}`);
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
    verboseRuntimeConsole.debug(
      "[Auth Store] Initializing MCP Gateway (background)...",
    );
    await initializeGateway();
    verboseRuntimeConsole.debug(
      "[Auth Store] MCP Gateway initialized successfully",
    );
    setState("mcpConnected", true);

    // Trigger auto-connect for local MCP servers
    const { initMcpAutoConnect } = await import("@/lib/mcp/auto-connect");
    verboseRuntimeConsole.debug(
      "[Auth Store] Triggering MCP auto-connect for local servers...",
    );
    const results = await initMcpAutoConnect();
    verboseRuntimeConsole.debug(
      "[Auth Store] MCP auto-connect results:",
      results,
    );
  } catch (error) {
    console.error("[Auth Store] Failed to initialize MCP:", error);
    setState("mcpConnected", false);
  }
}

async function loadPrivateChatPolicy(): Promise<OrganizationPrivateChatPolicy | null> {
  try {
    return await getDefaultOrganizationPrivateChatPolicy();
  } catch (error) {
    console.warn("[Auth Store] Failed to load private chat policy:", error);
    return null;
  }
}

function authEpochChanged(expectedEpoch: number | undefined): boolean {
  return expectedEpoch !== undefined && expectedEpoch !== authEpoch;
}

async function activateAuthenticatedSession(
  user?: User,
  expectedEpoch?: number,
): Promise<boolean> {
  const privateChatPolicy = await loadPrivateChatPolicy();
  if (authEpochChanged(expectedEpoch)) {
    return false;
  }

  const apiKey = await ensureApiKey();
  if (authEpochChanged(expectedEpoch)) {
    return false;
  }

  if (!apiKey.ok) {
    void reportApiKeyFailure(apiKey.status, apiKey.error);

    // A 401/403 means the server rejected us for auth/permission reasons — the
    // JWT itself is no good (or this account can't provision a key), so we must
    // NOT present a logged-in shell. Clear the session and surface the blocking
    // sign-in modal: that IS the actionable error + retry. #2497.
    if (apiKey.status === 401 || apiKey.status === 403) {
      clearAuthState();
      requestSignInModal();
      return false;
    }

    // Any other failure (network, 5xx, unknown) is transient: the JWT is still
    // valid and the SerenDB key is only needed by MCP tools + the Claude memory
    // interceptor — NOT by the primary chat path, which goes direct to the
    // provider CLI on the JWT. Blocking the whole session here would break chat
    // for an otherwise-valid user, and (because this runs on auth:token-refreshed)
    // would spuriously force-logout mid-refresh. Keep the session; ensureApiKey
    // re-runs on the next refresh and self-heals, and the interceptor surfaces
    // the now-classified failure. #2497 (NEW P1-a).
    console.warn(
      "[Auth Store] API key provisioning failed transiently; keeping session, MCP + Claude memory will retry on next refresh",
    );
  }

  setState({
    ...(user !== undefined ? { user } : {}),
    isAuthenticated: true,
    privateChatPolicy,
    signInModalRequested: false,
  });

  // Initialize MCP Gateway in background (non-blocking)
  void initializeMcpInBackground();
  return true;
}

export async function restoreAuthenticatedSession(
  expectedEpoch: number = authEpoch,
): Promise<boolean> {
  if (!(await hasStoredToken())) {
    return false;
  }

  return activateAuthenticatedSession(undefined, expectedEpoch);
}

async function resetSkillsCatalog(): Promise<void> {
  try {
    const { skillsStore } = await import("@/stores/skills.store");
    skillsStore.resetRemoteCatalog();
  } catch (error) {
    console.warn("[Auth Store] Failed to reset skills catalog:", error);
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

    await activateAuthenticatedSession();
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
    await activateAuthenticatedSession(user);
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Log out and clear authentication state.
 * Cleans up MCP Gateway state and stored credentials.
 */
export async function logout(): Promise<void> {
  authEpoch += 1;

  // Reset MCP Gateway state
  await resetGateway();

  // Clear stored API key
  await clearSerenApiKey();

  await authLogout();
  await resetSkillsCatalog();
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
  authEpoch += 1;
  void resetSkillsCatalog();
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

export async function refreshPrivateChatPolicy(): Promise<OrganizationPrivateChatPolicy | null> {
  if (!state.isAuthenticated) {
    return null;
  }
  const privateChatPolicy = await loadPrivateChatPolicy();
  setState("privateChatPolicy", privateChatPolicy);
  return privateChatPolicy;
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
  await listen("auth:token-refreshed", async () => {
    verboseRuntimeConsole.debug(
      "[Auth Store] Token refreshed event from backend",
    );
    const restoreEpoch = authEpoch;
    try {
      await restoreAuthenticatedSession(restoreEpoch);
    } catch (error) {
      console.warn(
        "[Auth Store] Failed to restore auth state after backend refresh:",
        error,
      );
    }
  });
}

export const authStore = state;
