// ABOUTME: SerenDB MCP integration for built-in gateway access.
// ABOUTME: Auto-adds SerenDB server on sign-in and removes on sign-out.

import {
  addMcpServer,
  mcpSettings,
  removeMcpServer,
} from "@/stores/settings.store";
import type { McpLocalServerConfig } from "./types";

export const SERENDB_SERVER_NAME = "SerenDB";

/**
 * SerenDB server configuration for the Gateway MCP server.
 * Connects to mcp.serendb.com via SSE using a Node.js bridge.
 * Token is injected at runtime from auth store.
 */
export const serenDbServerConfig: Omit<McpLocalServerConfig, "env"> = {
  type: "local",
  name: SERENDB_SERVER_NAME,
  command: "node",
  args: [
    "scripts/mcp-gateway-bridge.js",
    "--token={{TOKEN}}", // Placeholder - replaced at runtime
  ],
  description: "Seren's built-in MCP server for AI agents and publishers",
  enabled: true,
  autoConnect: true,
};

/**
 * Check if SerenDB server is already configured.
 */
export function isSerenDbConfigured(): boolean {
  return mcpSettings().servers.some((s) => s.name === SERENDB_SERVER_NAME);
}

/**
 * Get SerenDB server config with token injected.
 */
function getSerenDbConfigWithToken(token: string): McpLocalServerConfig {
  return {
    ...serenDbServerConfig,
    args: serenDbServerConfig.args.map((arg) =>
      arg.replace("{{TOKEN}}", token),
    ),
  };
}

/**
 * Add SerenDB as a default MCP server.
 * Called when user signs in successfully.
 */
export async function addSerenDbServer(token: string): Promise<void> {
  if (isSerenDbConfigured()) {
    return;
  }

  const config = getSerenDbConfigWithToken(token);
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
 * Ensure SerenDB server is configured for authenticated users.
 * Idempotent - safe to call multiple times.
 */
export async function ensureSerenDbServer(token: string): Promise<void> {
  await addSerenDbServer(token);
}
