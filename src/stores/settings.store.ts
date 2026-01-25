// ABOUTME: Settings store for managing user preferences.
// ABOUTME: Persists settings to Tauri store for cross-session persistence.

import { createStore } from "solid-js/store";

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

const STORAGE_KEY = "seren:settings";

/**
 * Load settings from Tauri store.
 */
async function loadSettings(): Promise<Partial<Settings>> {
  try {
    // Try to load from localStorage (Tauri store integration can be added later)
    const localSaved = localStorage.getItem(STORAGE_KEY);
    if (localSaved) {
      return JSON.parse(localSaved);
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

/**
 * Save settings to storage.
 */
async function saveSettings(settings: Settings): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore save errors
  }
}

const [state, setState] = createStore<Settings>({ ...DEFAULT_SETTINGS });

/**
 * Settings store with reactive state and actions.
 */
export const settingsStore = {
  /**
   * Get all settings.
   */
  get settings(): Settings {
    return state;
  },

  /**
   * Get a specific setting.
   */
  get<K extends keyof Settings>(key: K): Settings[K] {
    return state[key];
  },

  /**
   * Set a specific setting.
   */
  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setState(key, value);
    saveSettings(state);
  },

  /**
   * Update multiple settings at once.
   */
  update(updates: Partial<Settings>): void {
    setState(updates);
    saveSettings(state);
  },

  /**
   * Reset all settings to defaults.
   */
  reset(): void {
    setState({ ...DEFAULT_SETTINGS });
    saveSettings(state);
  },

  /**
   * Reset a specific setting to default.
   */
  resetKey<K extends keyof Settings>(key: K): void {
    setState(key, DEFAULT_SETTINGS[key]);
    saveSettings(state);
  },

  /**
   * Load settings from storage.
   */
  async load(): Promise<void> {
    const saved = await loadSettings();
    setState({ ...DEFAULT_SETTINGS, ...saved });
  },

  /**
   * Check if a setting differs from default.
   */
  isModified<K extends keyof Settings>(key: K): boolean {
    return state[key] !== DEFAULT_SETTINGS[key];
  },

  /**
   * Get default value for a setting.
   */
  getDefault<K extends keyof Settings>(key: K): Settings[K] {
    return DEFAULT_SETTINGS[key];
  },
};

// Auto-load settings on import
settingsStore.load();
