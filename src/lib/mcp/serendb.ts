// ABOUTME: SerenDB MCP integration for built-in gateway access.
// ABOUTME: Auto-adds SerenDB server on sign-in and removes on sign-out.

import type { McpBuiltinServerConfig } from "./types";
import { mcpSettings, addMcpServer, removeMcpServer } from "@/stores/settings.store";

export const SERENDB_SERVER_NAME = "SerenDB";
export const SERENDB_BUILTIN_ID = "serendb";

/**
 * SerenDB server configuration for the built-in MCP server.
 */
export const serenDbServerConfig: McpBuiltinServerConfig = {
  type: "builtin",
  name: SERENDB_SERVER_NAME,
  builtinId: SERENDB_BUILTIN_ID,
  description: "Seren's built-in MCP server for AI agents and publishers",
  enabled: true,
  autoConnect: true,
};

/**
 * Check if SerenDB server is already configured.
 */
export function isSerenDbConfigured(): boolean {
  return mcpSettings().servers.some(
    (s) => s.name === SERENDB_SERVER_NAME || (s.type === "builtin" && s.builtinId === SERENDB_BUILTIN_ID)
  );
}

/**
 * Add SerenDB as a default MCP server.
 * Called when user signs in successfully.
 */
export async function addSerenDbServer(): Promise<void> {
  if (isSerenDbConfigured()) {
    return;
  }

  await addMcpServer(serenDbServerConfig);
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
 * Ensure SerenDB server is configured for authenticated users.
 * Idempotent - safe to call multiple times.
 */
export async function ensureSerenDbServer(): Promise<void> {
  await addSerenDbServer();
}
