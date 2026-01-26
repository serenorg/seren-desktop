// ABOUTME: Barrel export for MCP module.
// ABOUTME: Re-exports all MCP types, client, and utilities.

export {
  connectAllEnabledServers,
  disconnectAllServers,
  initMcpAutoConnect,
  retryFailedConnections,
} from "./auto-connect";
export { mcpClient } from "./client";
export {
  formatErrorForLogging,
  getErrorMessage,
  isRecoverableError,
  McpConnectionError,
  McpError,
  McpErrorCode,
  McpResourceError,
  McpToolError,
  parseMcpError,
} from "./errors";
export { getRiskLabel, getToolRiskLevel } from "./risk";
export {
  addSerenDbServer,
  ensureSerenDbServer,
  isSerenDbConfigured,
  removeSerenDbServer,
  SERENDB_BUILTIN_ID,
  SERENDB_SERVER_NAME,
  serenDbServerConfig,
} from "./serendb";
export * from "./types";
