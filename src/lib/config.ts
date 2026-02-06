// ABOUTME: Centralized configuration for all Seren service URLs.
// ABOUTME: All API/MCP calls must use these values for consistency and security.

/**
 * Seren Gateway API base URL.
 * SECURITY: Must always be HTTPS in production.
 * NOTE: Seren Gateway API does NOT use a version prefix.
 */
export const API_BASE =
  import.meta.env.VITE_SEREN_API_URL ?? "https://api.serendb.com";

/**
 * MCP Gateway base URL (for MCP protocol connections).
 */
export const MCP_GATEWAY_URL =
  import.meta.env.VITE_MCP_GATEWAY_URL ?? "https://mcp.serendb.com/mcp";

/**
 * MCP OAuth base URL (for OAuth flows against the MCP server).
 */
export const MCP_OAUTH_BASE =
  import.meta.env.VITE_MCP_OAUTH_BASE ?? "https://mcp.serendb.com";

// Backwards-compat alias
export const apiBase = API_BASE;
export const API_URL = API_BASE;

export const config = {
  apiBase,
};
