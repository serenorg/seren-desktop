// ABOUTME: SerenDB MCP integration for built-in gateway access.
// ABOUTME: Auto-adds SerenDB server on sign-in and removes on sign-out.

import { resolveResource } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import {
  addMcpServer,
  mcpSettings,
  removeMcpServer,
} from "@/stores/settings.store";
import type { McpLocalServerConfig } from "./types";

export const SERENDB_SERVER_NAME = "Seren MCP";
export const SERENDB_BUILTIN_ID = "serendb-builtin";

/**
 * Check if SerenDB server is already configured.
 */
export function isSerenDbConfigured(): boolean {
  return mcpSettings().servers.some((s) => s.name === SERENDB_SERVER_NAME);
}

/**
 * Get the absolute path to node executable.
 */
async function getNodePath(): Promise<string> {
  // In production, we might bundle node - check for that first
  try {
    const bundledNode = await resolveResource("bin/node");
    return bundledNode;
  } catch {
    // Not bundled, use system node
  }

  // For now, use the most common macOS location
  return "/usr/local/bin/node";
}

/**
 * Get the absolute path to the bridge script.
 */
async function getBridgePath(): Promise<string> {
  // Try to resolve from bundled resources (production)
  try {
    const bundledPath = await resolveResource("scripts/mcp-gateway-bridge.cjs");
    console.log("[SerenDB] Using bundled bridge path:", bundledPath);
    return bundledPath;
  } catch (e) {
    console.log("[SerenDB] Bundled bridge not found, using dev path");
  }
  
  // Development fallback: get the app's resource directory
  try {
    // Use Tauri to get the resource dir which should be project root in dev
    const resourceDir = await invoke<string>("get_resource_dir").catch(() => null);
    if (resourceDir) {
      return `${resourceDir}/scripts/mcp-gateway-bridge.cjs`;
    }
  } catch {
    // Ignore
  }
  
  // Final fallback: hardcoded dev path
  // This works because we know the project structure
  return "/Users/taariqlewis/Projects/Seren_Projects/seren-desktop/scripts/mcp-gateway-bridge.cjs";
}

/**
 * Get the SerenDB server configuration.
 * Resolves the bridge script path at runtime.
 */
async function getSerenDbServerConfig(apiKey: string): Promise<McpLocalServerConfig> {
  const nodePath = await getNodePath();
  const bridgePath = await getBridgePath();
  
  console.log("[SerenDB] Config - node:", nodePath, "bridge:", bridgePath);

  return {
    type: "local",
    name: SERENDB_SERVER_NAME,
    command: nodePath,
    args: [bridgePath, `--token=${apiKey}`],
    enabled: true,
    autoConnect: true,
  };
}

/**
 * SerenDB server configuration template (for reference/exports).
 * Actual config is built dynamically with getSerenDbServerConfig().
 */
export const serenDbServerConfig: Omit<McpLocalServerConfig, "env"> = {
  type: "local",
  name: SERENDB_SERVER_NAME,
  command: "node",
  args: ["scripts/mcp-gateway-bridge.cjs", "--token={{API_KEY}}"],
  enabled: true,
  autoConnect: true,
};

/**
 * Add Seren MCP as the default MCP server.
 * Injects the API key into the bridge command.
 * Always removes existing config first to ensure fresh API key.
 */
export async function addSerenDbServer(apiKey: string): Promise<void> {
  // Migration: remove old "SerenDB" entry if it exists
  const oldServerName = "SerenDB";
  if (mcpSettings().servers.some((s) => s.name === oldServerName)) {
    await removeMcpServer(oldServerName);
  }

  // Always remove first to ensure fresh config with new API key
  if (isSerenDbConfigured()) {
    await removeMcpServer(SERENDB_SERVER_NAME);
  }

  // Get config with resolved absolute paths
  const config = await getSerenDbServerConfig(apiKey);

  console.log("[Seren MCP] Adding server with config:", {
    command: config.command,
    args: config.args.map((a) => (a.includes("token") ? "--token=***" : a)),
  });

  await addMcpServer(config);
}

/**
 * Remove SerenDB MCP server.
 * Called when user signs out.
 */
export async function removeSerenDbServer(): Promise<void> {
  if (!isSerenDbConfigured()) {
    return;
  }

  await removeMcpServer(SERENDB_SERVER_NAME);
}

/**
 * Ensure SerenDB server is configured.
 * Idempotent - safe to call multiple times.
 */
export async function ensureSerenDbServer(apiKey: string): Promise<void> {
  await addSerenDbServer(apiKey);
}
