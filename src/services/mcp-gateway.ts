// ABOUTME: MCP Gateway service for connecting to Seren MCP gateway via MCP protocol.
// ABOUTME: Uses rmcp HTTP streaming transport to connect to mcp.serendb.com/mcp.

import { mcpClient } from "@/lib/mcp/client";
import type { McpTool, McpToolResult } from "@/lib/mcp/types";
import {
  clearStoredTokens,
  getValidAccessToken,
  isMcpAuthenticated,
} from "./mcp-oauth";

const MCP_GATEWAY_URL = "https://mcp.serendb.com/mcp";
const SEREN_MCP_SERVER_NAME = "seren-gateway";

// Cache configuration
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Types for gateway tools (with publisher info parsed from tool name)
export interface GatewayTool {
  publisher: string;
  publisherName: string;
  tool: McpToolInfo;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, McpPropertySchema>;
    required?: string[];
  };
}

export interface McpPropertySchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: McpPropertySchema;
  default?: unknown;
}

export interface McpToolCallResponse {
  result: unknown;
  is_error: boolean;
  execution_time_ms: number;
  response_bytes: number;
}

/**
 * Custom error for MCP Gateway failures.
 */
class McpGatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    public endpoint: string,
  ) {
    super(message);
    this.name = "McpGatewayError";
  }
}

// Singleton state for caching tools
let cachedTools: GatewayTool[] = [];
let lastFetchedAt: number | null = null;
let loadingPromise: Promise<void> | null = null;
let isConnected = false;

/**
 * Check if the cache is still valid (not expired).
 */
function isCacheValid(): boolean {
  if (!lastFetchedAt || cachedTools.length === 0) return false;
  return Date.now() - lastFetchedAt < CACHE_TTL_MS;
}

/**
 * Parse publisher slug from MCP tool name.
 * Seren MCP tools are named like "mcp__publisher-slug__tool-name"
 */
function parsePublisherFromToolName(toolName: string): {
  publisher: string;
  originalName: string;
} {
  const match = toolName.match(/^mcp__([^_]+)__(.+)$/);
  if (match) {
    return { publisher: match[1], originalName: match[2] };
  }
  // Fallback for tools without publisher prefix
  return { publisher: "seren", originalName: toolName };
}

/**
 * Convert MCP tool to GatewayTool format.
 */
function convertToGatewayTool(tool: McpTool): GatewayTool {
  const { publisher } = parsePublisherFromToolName(tool.name);
  return {
    publisher,
    publisherName: publisher, // We don't have the display name from MCP
    tool: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as McpToolInfo["inputSchema"],
    },
  };
}

/**
 * Check if MCP OAuth authentication is required.
 * Returns true if user needs to complete OAuth flow.
 */
export async function needsMcpAuth(): Promise<boolean> {
  return !(await isMcpAuthenticated());
}

/**
 * Initialize the gateway by connecting to mcp.serendb.com/mcp.
 * Safe to call multiple times - uses cached data if still valid.
 * Requires MCP OAuth token - call needsMcpAuth() first to check.
 */
export async function initializeGateway(): Promise<void> {
  // Return cached data if still valid
  if (isCacheValid() && isConnected) {
    console.log("[MCP Gateway] Using cached tools (still valid)");
    return;
  }

  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    console.log("[MCP Gateway] Initializing via MCP protocol...");

    // Get MCP OAuth token (not the SerenDB API key)
    const mcpToken = await getValidAccessToken();
    if (!mcpToken) {
      console.error(
        "[MCP Gateway] No MCP OAuth token - user needs to authenticate",
      );
      throw new McpGatewayError(
        "MCP authentication required",
        401,
        MCP_GATEWAY_URL,
      );
    }

    try {
      // Connect to Seren MCP Gateway via HTTP streaming transport
      console.log(`[MCP Gateway] Connecting to ${MCP_GATEWAY_URL}...`);
      await mcpClient.connectHttp(
        SEREN_MCP_SERVER_NAME,
        MCP_GATEWAY_URL,
        mcpToken,
      );
      isConnected = true;
      console.log("[MCP Gateway] Connected successfully");

      // Get the connection and its tools
      const connection = mcpClient.getConnection(SEREN_MCP_SERVER_NAME);
      if (!connection) {
        throw new Error("Connection not found after connecting");
      }

      // Convert MCP tools to GatewayTool format
      cachedTools = connection.tools.map(convertToGatewayTool);
      lastFetchedAt = Date.now();

      console.log(
        `[MCP Gateway] Initialized with ${cachedTools.length} tools via MCP protocol`,
      );
    } catch (error) {
      console.error("[MCP Gateway] Failed to connect:", error);
      isConnected = false;
      throw error;
    }
  })();

  await loadingPromise;
  loadingPromise = null;
}

/**
 * Get all cached gateway tools.
 * Returns empty array if not initialized.
 */
export function getGatewayTools(): GatewayTool[] {
  return cachedTools;
}

/**
 * Check if gateway is initialized with valid cache.
 */
export function isGatewayInitialized(): boolean {
  return isCacheValid() && isConnected;
}

/**
 * Reset gateway state (for logout).
 * Clears MCP OAuth tokens and disconnects.
 */
export async function resetGateway(): Promise<void> {
  // Disconnect from MCP server if connected
  if (isConnected) {
    mcpClient.disconnectHttp(SEREN_MCP_SERVER_NAME).catch((error) => {
      console.error("[MCP Gateway] Error disconnecting:", error);
    });
  }

  // Clear MCP OAuth tokens
  await clearStoredTokens();

  cachedTools = [];
  lastFetchedAt = null;
  loadingPromise = null;
  isConnected = false;
}

/**
 * Call a tool via the MCP Gateway.
 */
export async function callGatewayTool(
  _publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResponse> {
  if (!isConnected) {
    throw new McpGatewayError(
      "MCP Gateway not connected",
      503,
      MCP_GATEWAY_URL,
    );
  }

  const startTime = Date.now();

  try {
    const result: McpToolResult = await mcpClient.callToolHttp(
      SEREN_MCP_SERVER_NAME,
      { name: toolName, arguments: args },
    );

    const executionTime = Date.now() - startTime;

    return {
      result: result.content,
      is_error: result.isError ?? false,
      execution_time_ms: executionTime,
      response_bytes: JSON.stringify(result).length,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    console.error("[MCP Gateway] Tool call failed:", error);

    return {
      result: error instanceof Error ? error.message : String(error),
      is_error: true,
      execution_time_ms: executionTime,
      response_bytes: 0,
    };
  }
}
