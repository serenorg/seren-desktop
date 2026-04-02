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

// All publisher slugs from the last list_agent_publishers call.
// This is the canonical source of callable publishers — includes publishers
// that are reachable via call_publisher but don't expose first-class MCP tools.
let cachedPublisherSlugs: string[] = [];

// Track first-class MCP tools from the gateway's list_tools() response.
// These tools can be called directly via MCP protocol, bypassing call_publisher.
// Key: "publisher:toolName", Value: original MCP tool name (e.g., "mcp__mcp-time__get_current_time").
const nativeMcpTools: Map<string, string> = new Map();

/**
 * Check if the cache is still valid (not expired).
 */
function isCacheValid(): boolean {
  if (!lastFetchedAt || cachedTools.length === 0) return false;
  return Date.now() - lastFetchedAt < CACHE_TTL_MS;
}

/**
 * Parse publisher slug from MCP tool name.
 * Publisher tools are named like "mcp__publisher-slug__tool-name".
 * Returns null for built-in gateway tools (no mcp__ prefix).
 */
function parsePublisherFromToolName(toolName: string): {
  publisher: string;
  originalName: string;
} | null {
  const match = toolName.match(/^mcp__([^_]+)__(.+)$/);
  if (match) {
    return { publisher: match[1], originalName: match[2] };
  }
  return null;
}

/**
 * Convert MCP tool to GatewayTool format.
 * Stores the bare tool name (without mcp__publisher__ prefix) so that
 * callGatewayTool() can dispatch through call_publisher correctly.
 * Returns null for built-in gateway tools (no publisher prefix).
 */
function convertToGatewayTool(tool: McpTool): GatewayTool | null {
  const parsed = parsePublisherFromToolName(tool.name);
  if (!parsed) return null;
  return {
    publisher: parsed.publisher,
    publisherName: parsed.publisher,
    tool: {
      name: parsed.originalName,
      description: tool.description,
      inputSchema: tool.inputSchema as McpToolInfo["inputSchema"],
    },
  };
}

/**
 * Discover dynamic publisher tools via the gateway.
 *
 * Queries `list_agent_publishers` for all active publishers, then calls
 * `list_mcp_tools` for each to discover tools (Gmail, Google Calendar, etc.).
 * Publishers that don't expose tools return empty/error and are skipped.
 */
async function discoverPublisherTools(): Promise<GatewayTool[]> {
  // Get all available publishers from the gateway
  const pubResult: McpToolResult = await mcpClient.callToolHttp(
    SEREN_MCP_SERVER_NAME,
    { name: "list_agent_publishers", arguments: {} },
  );

  if (pubResult.isError || !pubResult.content) return [];

  let publisherSlugs: string[] = [];
  try {
    const contentArray = pubResult.content as Array<{
      type: string;
      text?: string;
    }>;
    const textContent = contentArray?.find((c) => c.type === "text")?.text;
    if (textContent) {
      const parsed = JSON.parse(textContent);
      const pubs = parsed.publishers ?? parsed.data ?? parsed ?? [];
      publisherSlugs = pubs
        .map((p: { slug?: string; name?: string }) => p.slug ?? p.name)
        .filter(Boolean);
    }
  } catch {
    return [];
  }

  if (publisherSlugs.length === 0) return [];

  // Cache the full publisher list — this is the canonical source of callable
  // publishers, regardless of whether they expose first-class MCP tools.
  cachedPublisherSlugs = publisherSlugs;

  // For each MCP publisher, query its tools
  const allTools: GatewayTool[] = [];
  const results = await Promise.allSettled(
    publisherSlugs.map(async (slug) => {
      const toolResult: McpToolResult = await mcpClient.callToolHttp(
        SEREN_MCP_SERVER_NAME,
        { name: "list_mcp_tools", arguments: { publisher: slug } },
      );
      if (toolResult.isError || !toolResult.content) return [];

      const contentArray = toolResult.content as Array<{
        type: string;
        text?: string;
      }>;
      const textContent = contentArray?.find((c) => c.type === "text")?.text;
      if (!textContent) return [];

      let tools: Array<{
        name: string;
        description?: string;
        inputSchema?: McpToolInfo["inputSchema"];
      }> = [];
      try {
        const parsed = JSON.parse(textContent);
        tools = parsed.tools ?? parsed ?? [];
      } catch {
        return [];
      }

      return tools.map((tool) => ({
        publisher: slug,
        publisherName: slug,
        tool: {
          name: tool.name,
          description: tool.description ?? `${tool.name} from ${slug}`,
          inputSchema: tool.inputSchema ?? {
            type: "object" as const,
            properties: {} as Record<string, McpPropertySchema>,
          },
        },
      }));
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.length > 0) {
      allTools.push(...result.value);
    }
  }

  return allTools;
}

/**
 * Check if a tool is a first-class MCP tool on the gateway.
 * Native tools are called directly via MCP protocol instead of call_publisher.
 */
export function isNativeMcpTool(
  publisherSlug: string,
  toolName: string,
): boolean {
  return nativeMcpTools.has(`${publisherSlug}:${toolName}`);
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

      // Index first-class MCP tools from the gateway's tool list.
      // These can be called directly via MCP protocol without call_publisher.
      nativeMcpTools.clear();
      for (const tool of connection.tools) {
        const parsed = parsePublisherFromToolName(tool.name);
        if (parsed) {
          nativeMcpTools.set(
            `${parsed.publisher}:${parsed.originalName}`,
            tool.name,
          );
        }
      }

      // Convert publisher MCP tools to GatewayTool format (skip built-in tools)
      cachedTools = connection.tools
        .map(convertToGatewayTool)
        .filter((t): t is GatewayTool => t !== null);

      // Discover dynamic publisher tools (Gmail, Google Calendar, etc.)
      // that aren't in the static list_tools() response.
      try {
        const publisherTools = await discoverPublisherTools();
        if (publisherTools.length > 0) {
          // Merge, deduplicating by tool name
          const existingNames = new Set(cachedTools.map((t) => t.tool.name));
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
 * Get all callable publisher slugs from the last discovery.
 * This is the canonical source of publisher availability — includes publishers
 * reachable via call_publisher even if they expose no first-class MCP tools.
 */
export function getCallablePublisherSlugs(): string[] {
  return cachedPublisherSlugs;
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
  nativeMcpTools.clear();
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
 *
 * Native MCP tools (from the gateway's list_tools response) are called directly
 * via MCP protocol. REST-proxied publisher tools are dispatched through the
 * `call_publisher` meta-tool with `tool` + `tool_args`.
 */
export async function callGatewayTool(
  publisherSlug: string,
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
    // Separate x402 payment from tool args (call_publisher accepts it at top level)
    const { _x402_payment, ...toolArgs } = args;

    // Check if this is a first-class MCP tool on the gateway.
    // Native tools (from the gateway's list_tools response) are called directly
    // via MCP protocol, bypassing the call_publisher dispatch mechanism.
    // This is required for MCP-native publishers (e.g., mcp-time) whose tools
    // are not routable through the REST-oriented call_publisher meta-tool.
    const nativeName = nativeMcpTools.get(`${publisherSlug}:${toolName}`);

    let result: McpToolResult;
    if (nativeName) {
      result = await mcpClient.callToolHttp(SEREN_MCP_SERVER_NAME, {
        name: nativeName,
        arguments: toolArgs,
      });
    } else {
      const dispatchArgs: Record<string, unknown> = {
        publisher: publisherSlug,
        tool: toolName,
        tool_args: toolArgs,
      };
      if (_x402_payment !== undefined) {
        dispatchArgs._x402_payment = _x402_payment;
      }

      result = await mcpClient.callToolHttp(SEREN_MCP_SERVER_NAME, {
        name: "call_publisher",
        arguments: dispatchArgs,
      });
    }

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
