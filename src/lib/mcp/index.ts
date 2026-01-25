// ABOUTME: Barrel export for MCP module.
// ABOUTME: Re-exports all MCP types, client, and utilities.

export * from "./types";
export { mcpClient } from "./client";
export {
  initMcpAutoConnect,
  retryFailedConnections,
  connectAllEnabledServers,
  disconnectAllServers,
} from "./auto-connect";
