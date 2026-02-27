// ABOUTME: Settings store for managing user preferences, MCP configuration, and toolsets.
// ABOUTME: Persists settings to Tauri store for cross-session persistence.

import { createStore } from "solid-js/store";
import type { McpServerConfig, McpSettings } from "@/lib/mcp/types";
import { isTauriRuntime } from "@/lib/tauri-bridge";

const SETTINGS_STORE = "settings.json";
const MCP_SETTINGS_KEY = "mcp";
const APP_SETTINGS_KEY = "app";
const TOOLSETS_SETTINGS_KEY = "toolsets";
const BROWSER_SETTINGS_KEY = "seren_settings";
const BROWSER_MCP_KEY = "seren_mcp_settings";
const BROWSER_TOOLSETS_KEY = "seren_toolsets_settings";
const PLAYWRIGHT_SERVER_NAME = "playwright";
const PLAYWRIGHT_MCP_RELATIVE_SCRIPT =
  "mcp-servers/playwright-stealth/dist/index.js";

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
 * Application settings.
 */
export interface Settings {
  // Chat settings
  chatDefaultModel: string;
  chatMaxHistoryMessages: number;
  chatEnterToSend: boolean;
  chatShowThinking: boolean;
  /**
   * Whether thinking blocks should default to the expanded state.
   * Controlled by the in-UI chevron toggle so the preference persists.
   */
  chatThinkingExpanded: boolean;
  /**
   * Maximum tool call iterations per message.
   * Controls how many times the AI can use tools in a single response.
   * Higher values allow more complex multi-step tasks but use more credits.
   * Set to 0 for unlimited (use with caution - may run up costs).
   * Default: 10. Range: 0-50.
   */
  chatMaxToolIterations: number;

  // Auto-compact settings
  autoCompactEnabled: boolean;
  autoCompactThreshold: number;
  autoCompactPreserveMessages: number;

  // Editor settings
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;

  // Completion settings
  completionEnabled: boolean;
  completionDelay: number;
  completionMaxSuggestionLines: number;
  completionModelId: string;
  completionDisabledLanguages: string[];

  // Wallet settings
  showBalance: boolean;
  lowBalanceThreshold: number;

  // Auto top-up settings
  autoTopUpEnabled: boolean;
  autoTopUpThreshold: number;
  autoTopUpAmount: number;

  // Crypto wallet settings
  cryptoAutoApproveLimit: number;

  // Payment method settings
  preferredPaymentMethod: "serenbucks" | "crypto";
  enablePaymentFallback: boolean;

  // Theme settings
  theme: "dark" | "light" | "system";

  // Semantic indexing settings
  semanticIndexingEnabled: boolean;

  // Memory settings
  memoryEnabled: boolean;

  // Agent settings
  agentSandboxMode: "read-only" | "workspace-write" | "full-access";
  agentApprovalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  agentSearchEnabled: boolean;
  agentNetworkEnabled: boolean;
  agentAutoApproveReads: boolean;

  // Voice settings
  voiceAutoSubmit: boolean;

  // General settings
  telemetryEnabled: boolean;
}

/**
 * A toolset is a named collection of publisher slugs.
 * Groups publishers for a specific workflow without affecting their OAuth state.
 */
export interface Toolset {
  /** Unique identifier (UUID v4) */
  id: string;
  /** User-friendly name (e.g., "Sales Research", "Content Creation") */
  name: string;
  /** Optional description of what this toolset is for */
  description: string;
  /** Array of publisher slugs included in this toolset */
  publisherSlugs: string[];
  /** When the toolset was created (ISO timestamp) */
  createdAt: string;
  /** When the toolset was last modified (ISO timestamp) */
  updatedAt: string;
}

/**
 * Settings for toolset management.
 */
export interface ToolsetSettings {
  /** All user-created toolsets */
  toolsets: Toolset[];
  /** Currently active toolset ID, or null for "All Publishers" */
  activeToolsetId: string | null;
}

/**
 * Default settings values.
 */
const DEFAULT_SETTINGS: Settings = {
  // Chat
  chatDefaultModel: "anthropic/claude-sonnet-4",
  chatMaxHistoryMessages: 50,
  chatEnterToSend: true,
  chatShowThinking: false,
  chatThinkingExpanded: false,
  chatMaxToolIterations: 0,
  // Auto-compact
  autoCompactEnabled: true,
  autoCompactThreshold: 85,
  autoCompactPreserveMessages: 10,
  // Editor
  editorFontSize: 14,
  editorTabSize: 2,
  editorWordWrap: true,
  // Completion
  completionEnabled: true,
  completionDelay: 300,
  completionMaxSuggestionLines: 6,
  completionModelId: "anthropic/claude-sonnet-4",
  completionDisabledLanguages: ["markdown", "plaintext"],
  // Wallet
  showBalance: true,
  lowBalanceThreshold: 1.0,
  // Auto top-up
  autoTopUpEnabled: false,
  autoTopUpThreshold: 5.0,
  autoTopUpAmount: 25.0,
  // Crypto wallet
  cryptoAutoApproveLimit: 0.1,
  // Payment method
  preferredPaymentMethod: "serenbucks",
  enablePaymentFallback: true,
  // Theme
  theme: "dark",
  // Semantic indexing
  semanticIndexingEnabled: false,
  // Memory
  memoryEnabled: false,
  // Agent
  agentSandboxMode: "workspace-write",
  agentApprovalPolicy: "on-request",
  agentSearchEnabled: false,
  agentNetworkEnabled: true,
  agentAutoApproveReads: true,
  // Voice
  voiceAutoSubmit: true,
  // General
  telemetryEnabled: true,
};

function buildPlaywrightServer(scriptPath: string): McpServerConfig {
  return {
    name: PLAYWRIGHT_SERVER_NAME,
    type: "local",
    enabled: true,
    autoConnect: true,
    command: "node",
    args: [scriptPath],
    env: {},
  };
}

function buildDefaultMcpSettings(playwrightScriptPath: string): McpSettings {
  return {
    servers: [buildPlaywrightServer(playwrightScriptPath)],
    defaultTimeout: 30000,
  };
}

const defaultMcpSettings: McpSettings = buildDefaultMcpSettings(
  PLAYWRIGHT_MCP_RELATIVE_SCRIPT,
);

const defaultToolsetSettings: ToolsetSettings = {
  toolsets: [],
  activeToolsetId: null,
};

interface SettingsState {
  app: Settings;
  mcp: McpSettings;
  toolsets: ToolsetSettings;
  isLoading: boolean;
}

const [settingsState, setSettingsState] = createStore<SettingsState>({
  app: { ...DEFAULT_SETTINGS },
  mcp: defaultMcpSettings,
  toolsets: defaultToolsetSettings,
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
    const invoke = await getInvoke();
    let stored: string | null = null;

    if (invoke) {
      stored = await invoke<string | null>("get_setting", {
        store: SETTINGS_STORE,
        key: APP_SETTINGS_KEY,
      });
    } else {
      // Browser fallback
      stored = localStorage.getItem(BROWSER_SETTINGS_KEY);
    }

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
    const invoke = await getInvoke();
    const value = JSON.stringify(settingsState.app);

    if (invoke) {
      await invoke("set_setting", {
        store: SETTINGS_STORE,
        key: APP_SETTINGS_KEY,
        value,
      });
    } else {
      // Browser fallback
      localStorage.setItem(BROWSER_SETTINGS_KEY, value);
    }
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
    const invoke = await getInvoke();
    const playwrightScriptPath = await resolvePlaywrightMcpScriptPath();
    let stored: string | null = null;

    if (invoke) {
      stored = await invoke<string | null>("get_setting", {
        store: SETTINGS_STORE,
        key: MCP_SETTINGS_KEY,
      });
    } else {
      // Browser fallback
      stored = localStorage.getItem(BROWSER_MCP_KEY);
    }

    if (stored) {
      const parsed = JSON.parse(stored) as McpSettings;
      let hasChanges = false;

      // Migration: Add Playwright stealth server if it doesn't exist
      const hasPlaywrightServer = parsed.servers.some(
        (server) => server.name === PLAYWRIGHT_SERVER_NAME,
      );

      if (!hasPlaywrightServer) {
        parsed.servers.push(buildPlaywrightServer(playwrightScriptPath));
        hasChanges = true;
      }

      // Migration: Resolve old relative Playwright script path to absolute/resource path.
      parsed.servers = parsed.servers.map((server) => {
        if (
          server.name !== PLAYWRIGHT_SERVER_NAME ||
          server.type !== "local" ||
          server.command !== "node" ||
          server.args[0] !== PLAYWRIGHT_MCP_RELATIVE_SCRIPT
        ) {
          return server;
        }

        hasChanges = true;
        return {
          ...server,
          args: [playwrightScriptPath, ...server.args.slice(1)],
        };
      });

      setSettingsState("mcp", parsed);
      if (hasChanges) {
        await saveMcpSettings();
      }
    } else {
      setSettingsState("mcp", buildDefaultMcpSettings(playwrightScriptPath));
    }
  } catch {
    // Use defaults if loading fails
  }
}

async function resolvePlaywrightMcpScriptPath(): Promise<string> {
  if (!isTauriRuntime()) {
    return PLAYWRIGHT_MCP_RELATIVE_SCRIPT;
  }

  try {
    const invoke = await getInvoke();
    if (!invoke) {
      return PLAYWRIGHT_MCP_RELATIVE_SCRIPT;
    }

    const resolved = await invoke<string>("resolve_playwright_mcp_script_path");
    if (resolved && resolved.trim().length > 0) {
      return resolved;
    }
  } catch {
    // Fall back to legacy relative path if resolution command is unavailable.
  }

  return PLAYWRIGHT_MCP_RELATIVE_SCRIPT;
}

/**
 * Save MCP settings to persistent storage.
 */
async function saveMcpSettings(): Promise<void> {
  try {
    const invoke = await getInvoke();
    const value = JSON.stringify(settingsState.mcp);

    if (invoke) {
      await invoke("set_setting", {
        store: SETTINGS_STORE,
        key: MCP_SETTINGS_KEY,
        value,
      });
    } else {
      // Browser fallback
      localStorage.setItem(BROWSER_MCP_KEY, value);
    }
  } catch (error) {
    console.error("Failed to save MCP settings:", error);
    throw error;
  }
}

/**
 * Update MCP settings and persist.
 */
async function updateMcpSettings(
  updater: (prev: McpSettings) => McpSettings,
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
  updates: Partial<Omit<McpServerConfig, "type">>,
): Promise<void> {
  await updateMcpSettings((prev) => ({
    ...prev,
    servers: prev.servers.map((s) =>
      s.name === name ? ({ ...s, ...updates } as McpServerConfig) : s,
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
      s.name === name ? { ...s, enabled: !s.enabled } : s,
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
// Toolset Settings Functions
// ============================================================================

/**
 * Generate a UUID v4.
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Load toolset settings from persistent storage.
 */
async function loadToolsetSettings(): Promise<void> {
  try {
    const invoke = await getInvoke();
    let stored: string | null = null;

    if (invoke) {
      stored = await invoke<string | null>("get_setting", {
        store: SETTINGS_STORE,
        key: TOOLSETS_SETTINGS_KEY,
      });
    } else {
      // Browser fallback
      stored = localStorage.getItem(BROWSER_TOOLSETS_KEY);
    }

    if (stored) {
      const parsed = JSON.parse(stored) as ToolsetSettings;
      setSettingsState("toolsets", parsed);
    }
  } catch {
    // Use defaults if loading fails
  }
}

/**
 * Save toolset settings to persistent storage.
 */
async function saveToolsetSettings(): Promise<void> {
  try {
    const invoke = await getInvoke();
    const value = JSON.stringify(settingsState.toolsets);

    if (invoke) {
      await invoke("set_setting", {
        store: SETTINGS_STORE,
        key: TOOLSETS_SETTINGS_KEY,
        value,
      });
    } else {
      // Browser fallback
      localStorage.setItem(BROWSER_TOOLSETS_KEY, value);
    }
  } catch (error) {
    console.error("Failed to save toolset settings:", error);
    throw error;
  }
}

/**
 * Create a new toolset.
 */
async function createToolset(
  name: string,
  description: string,
  publisherSlugs: string[] = [],
): Promise<Toolset> {
  const now = new Date().toISOString();
  const toolset: Toolset = {
    id: generateId(),
    name,
    description,
    publisherSlugs,
    createdAt: now,
    updatedAt: now,
  };

  setSettingsState("toolsets", "toolsets", (prev) => [...prev, toolset]);
  await saveToolsetSettings();
  return toolset;
}

/**
 * Update an existing toolset.
 */
async function updateToolset(
  id: string,
  updates: Partial<Pick<Toolset, "name" | "description" | "publisherSlugs">>,
): Promise<void> {
  setSettingsState("toolsets", "toolsets", (prev) =>
    prev.map((t) =>
      t.id === id
        ? { ...t, ...updates, updatedAt: new Date().toISOString() }
        : t,
    ),
  );
  await saveToolsetSettings();
}

/**
 * Delete a toolset.
 */
async function deleteToolset(id: string): Promise<void> {
  setSettingsState("toolsets", "toolsets", (prev) =>
    prev.filter((t) => t.id !== id),
  );
  await saveToolsetSettings();
}

/**
 * Add a publisher to a toolset.
 */
async function addPublisherToToolset(
  toolsetId: string,
  publisherSlug: string,
): Promise<void> {
  setSettingsState("toolsets", "toolsets", (prev) =>
    prev.map((t) =>
      t.id === toolsetId && !t.publisherSlugs.includes(publisherSlug)
        ? {
            ...t,
            publisherSlugs: [...t.publisherSlugs, publisherSlug],
            updatedAt: new Date().toISOString(),
          }
        : t,
    ),
  );
  await saveToolsetSettings();
}

/**
 * Remove a publisher from a toolset.
 */
async function removePublisherFromToolset(
  toolsetId: string,
  publisherSlug: string,
): Promise<void> {
  setSettingsState("toolsets", "toolsets", (prev) =>
    prev.map((t) =>
      t.id === toolsetId
        ? {
            ...t,
            publisherSlugs: t.publisherSlugs.filter((s) => s !== publisherSlug),
            updatedAt: new Date().toISOString(),
          }
        : t,
    ),
  );
  await saveToolsetSettings();
}

/**
 * Get a toolset by ID.
 */
function getToolset(id: string): Toolset | undefined {
  return settingsState.toolsets.toolsets.find((t) => t.id === id);
}

/**
 * Get all toolsets that contain a specific publisher.
 */
function getToolsetsForPublisher(publisherSlug: string): Toolset[] {
  return settingsState.toolsets.toolsets.filter((t) =>
    t.publisherSlugs.includes(publisherSlug),
  );
}

/**
 * Convenience accessor for toolset settings.
 */
function toolsetSettings(): ToolsetSettings {
  return settingsState.toolsets;
}

/**
 * Set the active toolset.
 * Pass null to use "All Publishers" (no filtering).
 */
async function setActiveToolset(id: string | null): Promise<void> {
  setSettingsState("toolsets", "activeToolsetId", id);
  await saveToolsetSettings();
}

/**
 * Get the currently active toolset, or undefined if none selected.
 */
function getActiveToolset(): Toolset | undefined {
  const id = settingsState.toolsets.activeToolsetId;
  if (!id) return undefined;
  return settingsState.toolsets.toolsets.find((t) => t.id === id);
}

/**
 * Get publisher slugs for the active toolset.
 * Returns null if no toolset is active (meaning "all publishers").
 */
function getActiveToolsetPublishers(): string[] | null {
  const toolset = getActiveToolset();
  if (!toolset) return null;
  return toolset.publisherSlugs;
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
    await Promise.all([
      loadAppSettings(),
      loadMcpSettings(),
      loadToolsetSettings(),
    ]);
  } finally {
    setSettingsState("isLoading", false);
  }
}

// Export store and actions
export {
  settingsState,
  loadAllSettings,
  // MCP exports
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
  // Toolset exports
  loadToolsetSettings,
  createToolset,
  updateToolset,
  deleteToolset,
  addPublisherToToolset,
  removePublisherFromToolset,
  getToolset,
  getToolsetsForPublisher,
  toolsetSettings,
  // Active toolset exports
  setActiveToolset,
  getActiveToolset,
  getActiveToolsetPublishers,
};
