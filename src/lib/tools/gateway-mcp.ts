// ABOUTME: Gateway MCP tool integration for builtin MCP servers.
// ABOUTME: Fetches and caches tools from MCP publishers via Seren Gateway API.

import { callMcpTool, listMcpTools, listStorePublishers } from "@/api";
import type { McpToolInfo } from "@/api/generated";
import { createSignal } from "solid-js";

/**
 * Prefix for gateway MCP tools to distinguish from local MCP tools.
 * Format: gwmcp__{publisherSlug}__{toolName}
 */
export const GATEWAY_MCP_TOOL_PREFIX = "gwmcp__";

/**
 * Gateway MCP tool with publisher info.
 */
export interface GatewayMcpTool {
  publisherSlug: string;
  publisherName: string;
  tool: McpToolInfo;
}

/**
 * Parse a gateway MCP tool name to extract publisher slug and tool name.
 * Returns null if the name is not a gateway MCP tool.
 */
export function parseGatewayMcpToolName(
  name: string,
): { publisherSlug: string; toolName: string } | null {
  if (!name.startsWith(GATEWAY_MCP_TOOL_PREFIX)) {
    return null;
  }
  const rest = name.slice(GATEWAY_MCP_TOOL_PREFIX.length);
  const separatorIndex = rest.indexOf("__");
  if (separatorIndex === -1) {
    return null;
  }
  return {
    publisherSlug: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 2),
  };
}

/**
 * Gateway MCP tools cache using SolidJS signals.
 */
function createGatewayMcpClient() {
  const [tools, setTools] = createSignal<GatewayMcpTool[]>([]);
  const [isLoading, setIsLoading] = createSignal(false);
  const [lastError, setLastError] = createSignal<string | null>(null);
  const [lastFetchTime, setLastFetchTime] = createSignal<number>(0);

  // Cache validity period (5 minutes)
  const CACHE_TTL_MS = 5 * 60 * 1000;

  /**
   * Check if cache is still valid.
   */
  function isCacheValid(): boolean {
    const lastFetch = lastFetchTime();
    if (lastFetch === 0) return false;
    return Date.now() - lastFetch < CACHE_TTL_MS;
  }

  /**
   * Fetch tools from all MCP publishers.
   * Caches results for subsequent synchronous access.
   */
  async function fetchAllTools(): Promise<void> {
    // Skip if already loading or cache is valid
    if (isLoading() || isCacheValid()) {
      return;
    }

    setIsLoading(true);
    setLastError(null);

    try {
      // First, get all publishers
      const { data: publishersData } = await listStorePublishers({
        throwOnError: true,
      });

      if (!publishersData?.data) {
        throw new Error("No publishers data returned");
      }

      const mcpPublishers = publishersData.data;

      console.log(
        "[GatewayMCP] Found",
        mcpPublishers.length,
        "publishers:",
        mcpPublishers.map((p) => p.slug),
      );

      // Fetch tools from each publisher in parallel
      const allTools: GatewayMcpTool[] = [];
      const fetchResults = await Promise.allSettled(
        mcpPublishers.map(async (publisher) => {
          console.log(`[GatewayMCP] Fetching tools from ${publisher.slug}...`);
          const { data, error } = await listMcpTools({
            body: { publisher: publisher.slug },
            throwOnError: false,
          });

          if (error || !data) {
            console.warn(
              `[GatewayMCP] Failed to fetch tools from ${publisher.slug}:`,
              error,
            );
            return [];
          }

          // Extract tools from response
          const tools = data.tools || [];
          console.log(
            `[GatewayMCP] Publisher ${publisher.slug}: ${tools.length} tools`,
          );
          return tools.map((tool) => ({
            publisherSlug: publisher.slug,
            publisherName: publisher.name,
            tool,
          }));
        }),
      );

      // Collect successful results
      for (const result of fetchResults) {
        if (result.status === "fulfilled") {
          allTools.push(...result.value);
        }
      }

      console.log("[GatewayMCP] Cached", allTools.length, "gateway MCP tools");
      setTools(allTools);
      setLastFetchTime(Date.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[GatewayMCP] Error fetching tools:", message);
      setLastError(message);
    } finally {
      setIsLoading(false);
    }
  }

  /**
   * Get all cached gateway MCP tools synchronously.
   * Returns empty array if not yet fetched.
   */
  function getAllTools(): GatewayMcpTool[] {
    return tools();
  }

  /**
   * Call a gateway MCP tool via the Seren API.
   */
  async function callTool(
    publisherSlug: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    const { data, error } = await callMcpTool({
      body: {
        publisher: publisherSlug,
        tool_name: toolName,
        arguments: args,
      },
      throwOnError: false,
    });

    if (error) {
      const errorMessage =
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error);
      return {
        content: `Gateway MCP error: ${errorMessage}`,
        isError: true,
      };
    }

    // Extract content from MCP response
    // The result is the raw MCP response which may contain content array
    let content = "";
    const result = data?.result as {
      content?: Array<{ type: string; text?: string }>;
    } | undefined;

    if (result?.content && Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === "text" && item.text) {
          content += item.text;
        }
      }
    } else if (typeof data?.result === "string") {
      content = data.result;
    } else if (data?.result) {
      content = JSON.stringify(data.result, null, 2);
    }

    return {
      content: content || "Tool executed successfully",
      isError: data?.is_error ?? false,
    };
  }

  /**
   * Clear the tools cache.
   */
  function clearCache(): void {
    setTools([]);
    setLastFetchTime(0);
    setLastError(null);
  }

  /**
   * Get loading state.
   */
  function getIsLoading(): boolean {
    return isLoading();
  }

  /**
   * Get last error.
   */
  function getLastError(): string | null {
    return lastError();
  }

  return {
    fetchAllTools,
    getAllTools,
    callTool,
    clearCache,
    getIsLoading,
    getLastError,
    isCacheValid,
  };
}

// Export singleton instance
export const gatewayMcpClient = createGatewayMcpClient();
