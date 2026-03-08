// ABOUTME: Runtime mode and capability detection shared by desktop and browser entrypoints.
// ABOUTME: Provides a single place to decide whether local-only features should be enabled.

import { isTauriRuntime } from "@/lib/tauri-bridge";

export type SerenRuntimeMode =
  | "desktop-native"
  | "browser-local"
  | "browser-hosted";

export interface SerenRuntimeCapabilities {
  agents: boolean;
  // Legacy alias for `agents` kept during the ACP migration.
  acp: boolean;
  localFiles: boolean;
  localMcp: boolean;
  openclaw: boolean;
  terminal: boolean;
  updater: boolean;
  remoteSerenAgent: boolean;
}

export interface SerenRuntimeConfig {
  mode: SerenRuntimeMode;
  capabilities: SerenRuntimeCapabilities;
  apiBaseUrl?: string;
  wsBaseUrl?: string;
  localProjectRoot?: string;
}

declare global {
  interface Window {
    __SEREN_RUNTIME_CONFIG__?: Partial<SerenRuntimeConfig>;
  }
}

const QUERY_MODE_KEY = "seren_runtime";

const DESKTOP_CAPABILITIES: SerenRuntimeCapabilities = {
  agents: true,
  acp: true,
  localFiles: true,
  localMcp: true,
  openclaw: true,
  terminal: true,
  updater: true,
  remoteSerenAgent: true,
};

const BROWSER_LOCAL_CAPABILITIES: SerenRuntimeCapabilities = {
  agents: true,
  acp: true,
  localFiles: true,
  localMcp: false,
  openclaw: false,
  terminal: false,
  updater: false,
  remoteSerenAgent: true,
};

const BROWSER_HOSTED_CAPABILITIES: SerenRuntimeCapabilities = {
  agents: false,
  acp: false,
  localFiles: false,
  localMcp: false,
  openclaw: false,
  terminal: false,
  updater: false,
  remoteSerenAgent: true,
};

let cachedConfig: SerenRuntimeConfig | null = null;

function isRuntimeMode(value: unknown): value is SerenRuntimeMode {
  return (
    value === "desktop-native" ||
    value === "browser-local" ||
    value === "browser-hosted"
  );
}

function defaultsForMode(mode: SerenRuntimeMode): SerenRuntimeCapabilities {
  switch (mode) {
    case "desktop-native":
      return DESKTOP_CAPABILITIES;
    case "browser-local":
      return BROWSER_LOCAL_CAPABILITIES;
    case "browser-hosted":
      return BROWSER_HOSTED_CAPABILITIES;
  }
}

function readBrowserModeOverride(): SerenRuntimeMode | null {
  if (typeof window === "undefined") return null;

  const injectedMode = window.__SEREN_RUNTIME_CONFIG__?.mode;
  if (isRuntimeMode(injectedMode)) {
    return injectedMode;
  }

  const params = new URLSearchParams(window.location.search);
  const queryMode = params.get(QUERY_MODE_KEY);
  if (queryMode === "local") return "browser-local";
  if (queryMode === "hosted") return "browser-hosted";

  return null;
}

function readMode(): SerenRuntimeMode {
  if (isTauriRuntime()) {
    return "desktop-native";
  }

  return readBrowserModeOverride() ?? "browser-hosted";
}

function readCapabilities(mode: SerenRuntimeMode): SerenRuntimeCapabilities {
  const defaults = defaultsForMode(mode);
  const injected = window.__SEREN_RUNTIME_CONFIG__?.capabilities;
  if (!injected) {
    return defaults;
  }

  const agents =
    injected.agents ?? injected.acp ?? defaults.agents ?? defaults.acp;
  const acp = injected.acp ?? injected.agents ?? defaults.acp ?? defaults.agents;

  return {
    ...defaults,
    ...injected,
    agents,
    acp,
  };
}

export function getRuntimeConfig(): SerenRuntimeConfig {
  if (cachedConfig) return cachedConfig;

  const mode = readMode();
  const injected =
    typeof window !== "undefined" ? window.__SEREN_RUNTIME_CONFIG__ : undefined;

  cachedConfig = {
    mode,
    capabilities: readCapabilities(mode),
    apiBaseUrl: injected?.apiBaseUrl,
    wsBaseUrl: injected?.wsBaseUrl,
    localProjectRoot: injected?.localProjectRoot,
  };

  return cachedConfig;
}

export function getRuntimeMode(): SerenRuntimeMode {
  return getRuntimeConfig().mode;
}

export function runtimeHasCapability(
  capability: keyof SerenRuntimeCapabilities,
): boolean {
  return getRuntimeConfig().capabilities[capability];
}

export function isHostedBrowserRuntime(): boolean {
  return getRuntimeMode() === "browser-hosted";
}

export function isLocalBrowserRuntime(): boolean {
  return getRuntimeMode() === "browser-local";
}
