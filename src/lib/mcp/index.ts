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
export {
  McpError,
  McpConnectionError,
  McpToolError,
  McpResourceError,
  McpErrorCode,
  parseMcpError,
  getErrorMessage,
  isRecoverableError,
  formatErrorForLogging,
} from "./errors";
export { getToolRiskLevel, getRiskLabel } from "./risk";
export {
  SERENDB_SERVER_NAME,
  SERENDB_BUILTIN_ID,
  serenDbServerConfig,
  isSerenDbConfigured,
  addSerenDbServer,
  removeSerenDbServer,
  ensureSerenDbServer,
} from "./serendb";
