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
 * Connects to api.serendb.com using a Node.js bridge.
 * API key is injected at runtime from auth store.
 */
export const serenDbServerConfig: Omit<McpLocalServerConfig, "env"> = {
  type: "local",
  name: SERENDB_SERVER_NAME,
  command: "node",
  args: [
    "scripts/mcp-gateway-bridge.cjs",
    "--token={{API_KEY}}",
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
 * Add SerenDB as a default MCP server.
 * Injects the API key into the bridge command.
 */
export async function addSerenDbServer(apiKey: string): Promise<void> {
  if (isSerenDbConfigured()) {
    return;
  }

  // Replace {{API_KEY}} placeholder with actual API key
  const config = {
    ...serenDbServerConfig,
    args: serenDbServerConfig.args.map((arg) =>
      arg.replace("{{API_KEY}}", apiKey)
    ),
  } as McpLocalServerConfig;

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
