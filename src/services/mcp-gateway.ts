// ABOUTME: MCP Gateway service for connecting to Seren MCP gateway via MCP protocol.
// ABOUTME: Uses rmcp HTTP streaming transport to connect to mcp.serendb.com/mcp.

import { MCP_GATEWAY_URL } from "@/lib/config";
import { mcpClient } from "@/lib/mcp/client";
import type { McpTool, McpToolResult } from "@/lib/mcp/types";
import { getSerenApiKey } from "@/lib/tauri-bridge";

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
  /** Payment proxy info - present when tool requires x402 payment and needs client-side signing */
  payment_proxy?: PaymentProxyInfo;
}

/**
 * Payment proxy error from MCP gateway.
 * Returned when a tool requires x402 payment and the server doesn't have a local wallet.
 * Client should sign the payment locally and retry with _x402_payment parameter.
 */
export interface PaymentProxyInfo {
  payment_required_header?: string;
  payment_requirements?: unknown;
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
 * Discover dynamic publisher tools by calling `list_mcp_tools` on the gateway.
 * These tools (Gmail, Google Calendar, etc.) are not in the static `list_tools()`
 * response — they're only available as data returned by calling `list_mcp_tools`.
 * We synthesize MCP-format tool names (`mcp__{publisher}__{toolName}`) so they
 * integrate seamlessly with the existing gateway tool routing.
 */
async function discoverPublisherTools(): Promise<GatewayTool[]> {
  const result: McpToolResult = await mcpClient.callToolHttp(
    SEREN_MCP_SERVER_NAME,
    { name: "list_mcp_tools", arguments: {} },
  );

  if (result.isError || !result.content) return [];

  // Parse the response — list_mcp_tools returns publisher objects with tools
  let publishers: Array<{
    name: string;
    description?: string;
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: McpToolInfo["inputSchema"];
    }>;
  }> = [];

  try {
    // MCP tool results come as content array with text entries
    const contentArray = result.content as Array<{
      type: string;
      text?: string;
    }>;
    const textContent = contentArray?.find((c) => c.type === "text")?.text;
    if (textContent) {
      const parsed = JSON.parse(textContent);
      publishers = parsed.publishers ?? parsed ?? [];
    }
  } catch {
    return [];
  }

  const gatewayTools: GatewayTool[] = [];
  for (const pub of publishers) {
    if (!pub.tools || !Array.isArray(pub.tools)) continue;
    for (const tool of pub.tools) {
      // Synthesize MCP-format tool name for gateway routing
      const mcpToolName = `mcp__${pub.name}__${tool.name}`;
      gatewayTools.push({
        publisher: pub.name,
        publisherName: pub.name,
        tool: {
          name: mcpToolName,
          description: tool.description ?? `${tool.name} from ${pub.name}`,
          inputSchema: tool.inputSchema ?? {
            type: "object",
            properties: {},
          },
        },
      });
    }
  }

  return gatewayTools;
}

/**
 * Check if MCP authentication is available.
 * With API key auth, this just checks if we have an API key stored.
 * Returns true if user needs to authenticate (no API key).
 */
export async function needsMcpAuth(): Promise<boolean> {
  const apiKey = await getSerenApiKey();
  return !apiKey;
}

/**
 * Initialize the gateway by connecting to mcp.serendb.com/mcp.
 * Safe to call multiple times - uses cached data if still valid.
 * Uses the stored Seren API key for authentication.
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

    // Get Seren API key (auto-created after OAuth login)
    const apiKey = await getSerenApiKey();
    if (!apiKey) {
      console.error(
        "[MCP Gateway] No Seren API key - user needs to complete login",
      );
      throw new McpGatewayError(
        "Seren API key required - please log in",
        401,
        MCP_GATEWAY_URL,
      );
    }

    try {
      // Connect to Seren MCP Gateway via HTTP streaming transport
      // The API key is passed as the bearer token
      console.log(`[MCP Gateway] Connecting to ${MCP_GATEWAY_URL}...`);
      await mcpClient.connectHttp(
        SEREN_MCP_SERVER_NAME,
        MCP_GATEWAY_URL,
        apiKey,
      );
      isConnected = true;
      console.log("[MCP Gateway] Connected successfully");

      // Get the connection and its tools
      const connection = mcpClient.getConnection(SEREN_MCP_SERVER_NAME);
      if (!connection) {
        throw new Error("Connection not found after connecting");
      }

      // Convert static MCP tools to GatewayTool format
      cachedTools = connection.tools.map(convertToGatewayTool);

      // Discover dynamic publisher tools (Gmail, Google Calendar, etc.)
      // that aren't in the static list_tools() response.
      try {
        const publisherTools = await discoverPublisherTools();
        if (publisherTools.length > 0) {
          // Merge, deduplicating by tool name
          const existingNames = new Set(
            cachedTools.map((t) => t.tool.name),
          );
          const newTools = publisherTools.filter(
            (t) => !existingNames.has(t.tool.name),
          );
          cachedTools = [...cachedTools, ...newTools];
          console.log(
            `[MCP Gateway] Discovered ${newTools.length} additional publisher tools`,
          );
        }
      } catch (err) {
        // Non-fatal — static tools still work
        console.warn("[MCP Gateway] Failed to discover publisher tools:", err);
      }

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
 * Disconnects from MCP server. API key is cleared separately in auth flow.
 */
export async function resetGateway(): Promise<void> {
  // Disconnect from MCP server if connected
  if (isConnected) {
    mcpClient.disconnectHttp(SEREN_MCP_SERVER_NAME).catch((error) => {
      console.error("[MCP Gateway] Error disconnecting:", error);
    });
  }

  cachedTools = [];
  lastFetchedAt = null;
  loadingPromise = null;
  isConnected = false;
}

/**
 * Check if a result contains a payment proxy error.
 * The MCP server returns this JSON structure when x402 payment is needed
 * but the server doesn't have a local wallet to sign.
 */
function parsePaymentProxyError(content: unknown): PaymentProxyInfo | null {
  // The error comes as text content with JSON inside
  if (!Array.isArray(content)) return null;

  for (const item of content) {
    if (typeof item === "object" && item !== null && "text" in item) {
      try {
        const parsed = JSON.parse((item as { text: string }).text);
        if (
          parsed &&
          typeof parsed === "object" &&
          parsed.error === "payment_required" &&
          parsed.proxy_payment === true
        ) {
          return {
            payment_required_header: parsed.payment_required_header,
            payment_requirements: parsed.payment_requirements,
          };
        }
      } catch {
        // Not JSON or doesn't match expected format
      }
    }
  }
  return null;
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

    // Check if this is a payment proxy error (x402 required, needs client signing)
    if (result.isError) {
      const paymentProxy = parsePaymentProxyError(result.content);
      if (paymentProxy) {
        return {
          result: result.content,
          is_error: true,
          execution_time_ms: executionTime,
          response_bytes: JSON.stringify(result).length,
          payment_proxy: paymentProxy,
        };
      }
    }

    return {
      result: result.content,
      is_error: result.isError ?? false,
      execution_time_ms: executionTime,
      response_bytes: JSON.stringify(result).length,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    console.error(
      `[MCP Gateway] Tool call failed: ${error instanceof Error ? error.message : String(error)}`,
    );

    return {
      result: error instanceof Error ? error.message : String(error),
      is_error: true,
      execution_time_ms: executionTime,
      response_bytes: 0,
    };
  }
}
