// ABOUTME: Settings store for managing user preferences and MCP configuration.
// ABOUTME: Persists settings to Tauri store for cross-session persistence.

import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import type { McpServerConfig, McpSettings } from "@/lib/mcp/types";

const SETTINGS_STORE = "settings.json";
const MCP_SETTINGS_KEY = "mcp";
const APP_SETTINGS_KEY = "app";

/**
 * Application settings.
 */
export interface Settings {
  // Editor settings
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;

  // Completion settings
  completionEnabled: boolean;
  completionDelay: number;
  completionDisabledLanguages: string[];

  // Wallet settings
  showBalance: boolean;
  lowBalanceThreshold: number;

  // Auto top-up settings
  autoTopUpEnabled: boolean;
  autoTopUpThreshold: number;
  autoTopUpAmount: number;

  // Theme settings
  theme: "dark" | "light" | "system";
}

/**
 * Default settings values.
 */
const DEFAULT_SETTINGS: Settings = {
  editorFontSize: 14,
  editorTabSize: 2,
  editorWordWrap: true,
  completionEnabled: true,
  completionDelay: 300,
  completionDisabledLanguages: ["markdown", "plaintext"],
  showBalance: true,
  lowBalanceThreshold: 1.0,
  autoTopUpEnabled: false,
  autoTopUpThreshold: 5.0,
  autoTopUpAmount: 25.0,
  theme: "dark",
};

const defaultMcpSettings: McpSettings = {
  servers: [],
  defaultTimeout: 30000,
};

interface SettingsState {
  app: Settings;
  mcp: McpSettings;
  isLoading: boolean;
}

const [settingsState, setSettingsState] = createStore<SettingsState>({
  app: { ...DEFAULT_SETTINGS },
  mcp: defaultMcpSettings,
  isLoading: true,
});

// ============================================================================
// App Settings Functions
// ============================================================================

/**
 * Load app settings from storage.
 */
async function loadAppSettings(): Promise<void> {
  try {
    const stored = await invoke<string | null>("get_setting", {
      store: SETTINGS_STORE,
      key: APP_SETTINGS_KEY,
    });

    if (stored) {
      const parsed = JSON.parse(stored) as Partial<Settings>;
      setSettingsState("app", { ...DEFAULT_SETTINGS, ...parsed });
    }
  } catch {
    // Use defaults if loading fails
  }
}

/**
 * Save app settings to storage.
 */
async function saveAppSettings(): Promise<void> {
  try {
    await invoke("set_setting", {
      store: SETTINGS_STORE,
      key: APP_SETTINGS_KEY,
      value: JSON.stringify(settingsState.app),
    });
  } catch (error) {
    console.error("Failed to save app settings:", error);
  }
}

/**
 * Settings store with reactive state and actions.
 */
export const settingsStore = {
  /**
   * Get all settings.
   */
  get settings(): Settings {
    return settingsState.app;
  },

  /**
   * Get a specific setting.
   */
  get<K extends keyof Settings>(key: K): Settings[K] {
    return settingsState.app[key];
  },

  /**
   * Set a specific setting.
   */
  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setSettingsState("app", key, value);
    saveAppSettings();
  },

  /**
   * Update multiple settings at once.
   */
  update(updates: Partial<Settings>): void {
    setSettingsState("app", (prev) => ({ ...prev, ...updates }));
    saveAppSettings();
  },

  /**
   * Reset all settings to defaults.
   */
  reset(): void {
    setSettingsState("app", { ...DEFAULT_SETTINGS });
    saveAppSettings();
  },

  /**
   * Reset a specific setting to default.
   */
  resetKey<K extends keyof Settings>(key: K): void {
    setSettingsState("app", key, DEFAULT_SETTINGS[key]);
    saveAppSettings();
  },

  /**
   * Check if a setting differs from default.
   */
  isModified<K extends keyof Settings>(key: K): boolean {
    return settingsState.app[key] !== DEFAULT_SETTINGS[key];
  },

  /**
   * Get default value for a setting.
   */
  getDefault<K extends keyof Settings>(key: K): Settings[K] {
    return DEFAULT_SETTINGS[key];
  },
};

// ============================================================================
// MCP Settings Functions
// ============================================================================

/**
 * Load MCP settings from persistent storage.
 */
async function loadMcpSettings(): Promise<void> {
  try {
    const stored = await invoke<string | null>("get_setting", {
      store: SETTINGS_STORE,
      key: MCP_SETTINGS_KEY,
    });

    if (stored) {
      const parsed = JSON.parse(stored) as McpSettings;
      setSettingsState("mcp", parsed);
    }
  } catch {
    // Use defaults if loading fails
  }
}

/**
 * Save MCP settings to persistent storage.
 */
async function saveMcpSettings(): Promise<void> {
  try {
    await invoke("set_setting", {
      store: SETTINGS_STORE,
      key: MCP_SETTINGS_KEY,
      value: JSON.stringify(settingsState.mcp),
    });
  } catch (error) {
    console.error("Failed to save MCP settings:", error);
    throw error;
  }
}

/**
 * Update MCP settings and persist.
 */
async function updateMcpSettings(
  updater: (prev: McpSettings) => McpSettings
): Promise<void> {
  const updated = updater(settingsState.mcp);
  setSettingsState("mcp", updated);
  await saveMcpSettings();
}

/**
 * Add a new MCP server configuration.
 */
async function addMcpServer(server: McpServerConfig): Promise<void> {
  await updateMcpSettings((prev) => ({
    ...prev,
    servers: [...prev.servers, server],
  }));
}

/**
 * Remove an MCP server configuration by name.
 */
async function removeMcpServer(name: string): Promise<void> {
  await updateMcpSettings((prev) => ({
    ...prev,
    servers: prev.servers.filter((s) => s.name !== name),
  }));
}

/**
 * Update an existing MCP server configuration.
 */
async function updateMcpServer(
  name: string,
  updates: Partial<McpServerConfig>
): Promise<void> {
  await updateMcpSettings((prev) => ({
    ...prev,
    servers: prev.servers.map((s) =>
      s.name === name ? { ...s, ...updates } : s
    ),
  }));
}

/**
 * Toggle an MCP server's enabled state.
 */
async function toggleMcpServer(name: string): Promise<void> {
  await updateMcpSettings((prev) => ({
    ...prev,
    servers: prev.servers.map((s) =>
      s.name === name ? { ...s, enabled: !s.enabled } : s
    ),
  }));
}

/**
 * Get all enabled MCP server configs.
 */
function getEnabledMcpServers(): McpServerConfig[] {
  return settingsState.mcp.servers.filter((s) => s.enabled);
}

/**
 * Get all auto-connect MCP server configs.
 */
function getAutoConnectMcpServers(): McpServerConfig[] {
  return settingsState.mcp.servers.filter((s) => s.enabled && s.autoConnect);
}

/**
 * Set the default timeout for MCP operations.
 */
async function setMcpDefaultTimeout(timeout: number): Promise<void> {
  await updateMcpSettings((prev) => ({
    ...prev,
    defaultTimeout: timeout,
  }));
}

/**
 * Convenience accessor for MCP settings.
 */
function mcpSettings(): McpSettings {
  return settingsState.mcp;
}

// ============================================================================
// Combined Load Function
// ============================================================================

/**
 * Load all settings from storage.
 */
async function loadAllSettings(): Promise<void> {
  setSettingsState("isLoading", true);
  try {
    await Promise.all([loadAppSettings(), loadMcpSettings()]);
  } finally {
    setSettingsState("isLoading", false);
  }
}

// Export store and actions
export {
  settingsState,
  loadAllSettings,
  loadMcpSettings,
  updateMcpSettings,
  addMcpServer,
  removeMcpServer,
  updateMcpServer,
  toggleMcpServer,
  getEnabledMcpServers,
  getAutoConnectMcpServers,
  setMcpDefaultTimeout,
  mcpSettings,
};
