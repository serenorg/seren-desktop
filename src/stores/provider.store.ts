// ABOUTME: Provider store for managing LLM provider API keys and selection.
// ABOUTME: Persists provider configuration to Tauri encrypted store.

import { createStore } from "solid-js/store";
import type { ProviderId, ProviderModel } from "@/lib/providers/types";
import {
  CONFIGURABLE_PROVIDERS,
  PROVIDER_CONFIGS,
} from "@/lib/providers/types";
import {
  clearOAuthCredentials,
  clearProviderKey,
  getConfiguredProviders,
  getOAuthProviders,
  getProviderKey,
  isTauriRuntime,
  storeProviderKey,
} from "@/lib/tauri-bridge";

const PROVIDER_SETTINGS_STORE = "provider-settings.json";
const PROVIDER_SETTINGS_KEY = "provider-settings";
const BROWSER_PROVIDER_SETTINGS_KEY = "seren_provider_settings";

/**
 * Get invoke function only when in Tauri runtime.
 */
async function getInvoke(): Promise<
  typeof import("@tauri-apps/api/core").invoke | null
> {
  if (!isTauriRuntime()) {
    return null;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

/**
 * Provider selection settings (persisted).
 */
interface ProviderSelectionSettings {
  activeProvider: ProviderId;
  activeModel: string;
}

/**
 * Authentication type for a configured provider.
 */
type AuthType = "api_key" | "oauth" | null;

/**
 * Provider store state.
 */
interface ProviderState {
  /** Currently active provider */
  activeProvider: ProviderId;
  /** Currently selected model ID */
  activeModel: string;
  /** List of providers with configured API keys (always includes "seren") */
  configuredProviders: ProviderId[];
  /** Providers configured via OAuth (subset of configuredProviders) */
  oauthProviders: ProviderId[];
  /** Available models per provider */
  providerModels: Record<ProviderId, ProviderModel[]>;
  /** Whether key validation is in progress */
  isValidating: boolean;
  /** Validation error message if any */
  validationError: string | null;
  /** Whether the store is loading */
  isLoading: boolean;
}

/**
 * Default models for each provider (used before fetching or as fallback).
 */
const DEFAULT_MODELS: Record<ProviderId, ProviderModel[]> = {
  seren: [
    // Anthropic
    {
      id: "anthropic/claude-opus-4.5",
      name: "Claude Opus 4.5",
      contextWindow: 200000,
    },
    {
      id: "anthropic/claude-sonnet-4",
      name: "Claude Sonnet 4",
      contextWindow: 200000,
    },
    {
      id: "anthropic/claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      contextWindow: 200000,
    },
    // OpenAI
    { id: "openai/gpt-5", name: "GPT-5", contextWindow: 128000 },
    { id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 128000 },
    { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000 },
    // Google Gemini
    {
      id: "google/gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      contextWindow: 1000000,
    },
    {
      id: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      contextWindow: 1000000,
    },
    {
      id: "google/gemini-3-flash-preview",
      name: "Gemini 3 Flash",
      contextWindow: 1000000,
    },
  ],
  anthropic: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      contextWindow: 200000,
    },
    {
      id: "claude-opus-4-20250514",
      name: "Claude Opus 4",
      contextWindow: 200000,
    },
    {
      id: "claude-3-5-sonnet-20241022",
      name: "Claude 3.5 Sonnet",
      contextWindow: 200000,
    },
    {
      id: "claude-3-opus-20240229",
      name: "Claude 3 Opus",
      contextWindow: 200000,
    },
    {
      id: "claude-3-haiku-20240307",
      name: "Claude 3 Haiku",
      contextWindow: 200000,
    },
  ],
  openai: [
    { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000 },
    { id: "gpt-4-turbo", name: "GPT-4 Turbo", contextWindow: 128000 },
    { id: "o1", name: "o1", contextWindow: 200000 },
    { id: "o1-mini", name: "o1 Mini", contextWindow: 128000 },
  ],
  gemini: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1000000 },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      contextWindow: 1000000,
    },
    {
      id: "gemini-2.0-flash",
      name: "Gemini 2.0 Flash",
      contextWindow: 1000000,
    },
  ],
};

const DEFAULT_STATE: ProviderState = {
  activeProvider: "seren",
  activeModel: "anthropic/claude-sonnet-4",
  configuredProviders: ["seren"],
  oauthProviders: [],
  providerModels: { ...DEFAULT_MODELS },
  isValidating: false,
  validationError: null,
  isLoading: true,
};

const [state, setState] = createStore<ProviderState>({ ...DEFAULT_STATE });

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Load provider selection settings from storage.
 */
async function loadProviderSelectionSettings(): Promise<void> {
  try {
    const invoke = await getInvoke();
    let stored: string | null = null;

    if (invoke) {
      stored = await invoke<string | null>("get_setting", {
        store: PROVIDER_SETTINGS_STORE,
        key: PROVIDER_SETTINGS_KEY,
      });
    } else {
      stored = localStorage.getItem(BROWSER_PROVIDER_SETTINGS_KEY);
    }

    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ProviderSelectionSettings>;
      if (parsed.activeProvider) {
        setState("activeProvider", parsed.activeProvider);
      }
      if (parsed.activeModel) {
        setState("activeModel", parsed.activeModel);
      }
    }
  } catch {
    // Use defaults if loading fails
  }
}

/**
 * Save provider selection settings to storage.
 */
async function saveProviderSelectionSettings(): Promise<void> {
  try {
    const invoke = await getInvoke();
    const settings: ProviderSelectionSettings = {
      activeProvider: state.activeProvider,
      activeModel: state.activeModel,
    };
    const value = JSON.stringify(settings);

    if (invoke) {
      await invoke("set_setting", {
        store: PROVIDER_SETTINGS_STORE,
        key: PROVIDER_SETTINGS_KEY,
        value,
      });
    } else {
      localStorage.setItem(BROWSER_PROVIDER_SETTINGS_KEY, value);
    }
  } catch (error) {
    console.error("Failed to save provider settings:", error);
  }
}

/**
 * Load list of configured providers from secure storage.
 */
async function loadConfiguredProviders(): Promise<void> {
  try {
    // Load API key providers
    const apiKeyProviders = await getConfiguredProviders();

    // Load OAuth providers
    const oauthProviderList = await getOAuthProviders();
    setState("oauthProviders", oauthProviderList as ProviderId[]);

    // Combine both lists, always include seren first
    const allProviders = new Set<ProviderId>(["seren"]);
    for (const p of apiKeyProviders) {
      if (p !== "seren") allProviders.add(p as ProviderId);
    }
    for (const p of oauthProviderList) {
      allProviders.add(p as ProviderId);
    }

    setState("configuredProviders", Array.from(allProviders));
  } catch {
    // Keep defaults if loading fails
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load all provider settings from storage.
 * Should be called on app startup.
 */
async function loadProviderSettings(): Promise<void> {
  setState("isLoading", true);
  try {
    await Promise.all([
      loadProviderSelectionSettings(),
      loadConfiguredProviders(),
    ]);
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Configure a provider with an API key.
 * Validates the key before storing.
 * @param providerId - The provider to configure
 * @param apiKey - The API key to store
 * @param validateFn - Function to validate the key (injected to avoid circular deps)
 * @returns true if configuration succeeded
 */
async function configureProvider(
  providerId: ProviderId,
  apiKey: string,
  validateFn?: (providerId: ProviderId, apiKey: string) => Promise<boolean>,
): Promise<boolean> {
  if (providerId === "seren") {
    return false; // Can't configure Seren with API key
  }

  setState("isValidating", true);
  setState("validationError", null);

  try {
    // Validate the key if validation function provided
    if (validateFn) {
      const isValid = await validateFn(providerId, apiKey);
      if (!isValid) {
        setState(
          "validationError",
          `Invalid API key for ${PROVIDER_CONFIGS[providerId].name}. Please check and try again.`,
        );
        return false;
      }
    }

    // Store the key securely
    await storeProviderKey(providerId, apiKey);

    // Update configured providers list
    if (!state.configuredProviders.includes(providerId)) {
      setState("configuredProviders", [
        ...state.configuredProviders,
        providerId,
      ]);
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    setState(
      "validationError",
      `Failed to configure ${PROVIDER_CONFIGS[providerId].name}: ${message}`,
    );
    return false;
  } finally {
    setState("isValidating", false);
  }
}

/**
 * Configure a provider via OAuth.
 * Called after successful OAuth flow - credentials are already stored.
 * @param providerId - The provider that was authenticated via OAuth
 */
async function configureOAuthProvider(providerId: ProviderId): Promise<void> {
  if (providerId === "seren") {
    return; // Seren doesn't use OAuth
  }

  // Add to OAuth providers list
  if (!state.oauthProviders.includes(providerId)) {
    setState("oauthProviders", [...state.oauthProviders, providerId]);
  }

  // Add to configured providers list
  if (!state.configuredProviders.includes(providerId)) {
    setState("configuredProviders", [...state.configuredProviders, providerId]);
  }
}

/**
 * Get the authentication type for a configured provider.
 * @returns "oauth" if configured via OAuth, "api_key" if via API key, null if not configured
 */
function getAuthType(providerId: ProviderId): AuthType {
  if (providerId === "seren") {
    return null; // Seren uses session auth, not API key or OAuth
  }

  if (state.oauthProviders.includes(providerId)) {
    return "oauth";
  }

  if (state.configuredProviders.includes(providerId)) {
    return "api_key";
  }

  return null;
}

/**
 * Remove a provider's configuration (API key or OAuth).
 */
async function removeProvider(providerId: ProviderId): Promise<void> {
  if (providerId === "seren") {
    return; // Can't remove Seren
  }

  // Clear API key if configured
  await clearProviderKey(providerId);

  // Clear OAuth credentials if configured
  if (state.oauthProviders.includes(providerId)) {
    await clearOAuthCredentials(providerId);
    setState(
      "oauthProviders",
      state.oauthProviders.filter((p: ProviderId) => p !== providerId),
    );
  }

  setState(
    "configuredProviders",
    state.configuredProviders.filter((p) => p !== providerId),
  );

  // If this was the active provider, switch to Seren
  if (state.activeProvider === providerId) {
    setActiveProvider("seren");
  }
}

/**
 * Check if a provider has been configured with an API key.
 */
function isProviderConfigured(providerId: ProviderId): boolean {
  return state.configuredProviders.includes(providerId);
}

/**
 * Get the API key for a provider (if configured).
 */
async function getApiKey(providerId: ProviderId): Promise<string | null> {
  if (providerId === "seren") {
    return null; // Seren uses auth token, not API key
  }
  return await getProviderKey(providerId);
}

/**
 * Set the active provider.
 */
function setActiveProvider(providerId: ProviderId): void {
  if (!state.configuredProviders.includes(providerId)) {
    return; // Can't activate unconfigured provider
  }

  setState("activeProvider", providerId);

  // Set default model for this provider
  const models = state.providerModels[providerId];
  if (models.length > 0 && !models.some((m) => m.id === state.activeModel)) {
    setState("activeModel", models[0].id);
  }

  saveProviderSelectionSettings();
}

/**
 * Set the active model.
 */
function setActiveModel(modelId: string): void {
  setState("activeModel", modelId);
  saveProviderSelectionSettings();
}

/**
 * Update available models for a provider.
 */
function setProviderModels(
  providerId: ProviderId,
  models: ProviderModel[],
): void {
  setState("providerModels", providerId, models);
}

/**
 * Get available models for a provider.
 */
function getModels(providerId: ProviderId): ProviderModel[] {
  return state.providerModels[providerId] || [];
}

/**
 * Clear any validation error.
 */
function clearValidationError(): void {
  setState("validationError", null);
}

/**
 * Get providers that can be added (not yet configured).
 */
function getUnconfiguredProviders(): ProviderId[] {
  return CONFIGURABLE_PROVIDERS.filter(
    (p) => !state.configuredProviders.includes(p),
  );
}

// ============================================================================
// Exports
// ============================================================================

export const providerStore = {
  // State accessors
  get state() {
    return state;
  },
  get activeProvider() {
    return state.activeProvider;
  },
  get activeModel() {
    return state.activeModel;
  },
  get configuredProviders() {
    return state.configuredProviders;
  },
  get oauthProviders() {
    return state.oauthProviders;
  },
  get isValidating() {
    return state.isValidating;
  },
  get validationError() {
    return state.validationError;
  },
  get isLoading() {
    return state.isLoading;
  },

  // Functions
  loadSettings: loadProviderSettings,
  configureProvider,
  configureOAuthProvider,
  removeProvider,
  isProviderConfigured,
  getApiKey,
  getAuthType,
  setActiveProvider,
  setActiveModel,
  setProviderModels,
  getModels,
  clearValidationError,
  getUnconfiguredProviders,
};

export { state as providerState };
