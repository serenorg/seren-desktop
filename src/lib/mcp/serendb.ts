// ABOUTME: Seren MCP Gateway configuration for built-in gateway access.
// ABOUTME: Manages the builtin server entry that represents the REST-based gateway connection.

import {
  addMcpServer,
  mcpSettings,
  removeMcpServer,
} from "@/stores/settings.store";
import type { McpBuiltinServerConfig } from "./types";

export const SERENDB_SERVER_NAME = "Seren MCP";
export const SERENDB_BUILTIN_ID = "serendb-builtin";

/**
 * Check if Seren MCP server is already configured.
 */
export function isSerenDbConfigured(): boolean {
  return mcpSettings().servers.some((s) => s.name === SERENDB_SERVER_NAME);
}

/**
 * Seren MCP server configuration (builtin type - uses REST API, not stdio).
 */
export const serenDbServerConfig: McpBuiltinServerConfig = {
  type: "builtin",
  name: SERENDB_SERVER_NAME,
  builtinId: SERENDB_BUILTIN_ID,
  description: "Seren MCP Gateway - 90+ tools from publishers",
  enabled: true,
  autoConnect: true,
};

/**
 * Add Seren MCP as the default MCP server.
 * This is a builtin server that uses REST API (no process to spawn).
 */
export async function addSerenDbServer(): Promise<void> {
  // Migration: remove old "SerenDB" entry if it exists
  const oldServerName = "SerenDB";
  if (mcpSettings().servers.some((s) => s.name === oldServerName)) {
    await removeMcpServer(oldServerName);
  }

  // Always remove first to ensure fresh config
  if (isSerenDbConfigured()) {
    await removeMcpServer(SERENDB_SERVER_NAME);
  }

  console.log("[Seren MCP] Adding builtin server config");
  await addMcpServer(serenDbServerConfig);
}

/**
 * Remove Seren MCP server.
 * Called when user signs out.
 */
export async function removeSerenDbServer(): Promise<void> {
  if (!isSerenDbConfigured()) {
    return;
  }

  await removeMcpServer(SERENDB_SERVER_NAME);
}

/**
 * Ensure Seren MCP server is configured.
 * Idempotent - safe to call multiple times.
 */
export async function ensureSerenDbServer(): Promise<void> {
  await addSerenDbServer();
}
