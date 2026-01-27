// ABOUTME: MCP Gateway service for fetching tools from Seren publishers via REST API.
// ABOUTME: Replaces the Node.js bridge with direct HTTP calls to api.serendb.com.

import { getApiKey } from "./auth";

const API_BASE = "https://api.serendb.com";

// Types matching the backend API responses
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

export interface McpToolsResponse {
  tools: McpToolInfo[];
  execution_time_ms: number;
}

export interface McpToolCallResponse {
  result: unknown;
  is_error: boolean;
  execution_time_ms: number;
  response_bytes: number;
}

export interface Publisher {
  id: string;
  slug: string;
  name: string;
  description?: string;
  is_active: boolean;
  mcp_endpoint?: string;
}

export interface GatewayTool {
  publisher: string;
  publisherName: string;
  tool: McpToolInfo;
}

/**
 * Retry wrapper with exponential backoff.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelay = options.initialDelayMs ?? 1000;
  let lastError: Error | null = null;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on 4xx errors (client errors)
      if (
        error instanceof McpGatewayError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        throw error;
      }

      if (attempt < maxRetries) {
        console.log(
          `[MCP Gateway] Attempt ${attempt} failed, retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  throw lastError ?? new Error("Request failed after retries");
}

/**
 * Custom error for MCP Gateway failures.
 */
export class McpGatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    public endpoint: string,
  ) {
    super(message);
    this.name = "McpGatewayError";
  }
}

/**
 * Make an authenticated request to the MCP Gateway API.
 */
async function gatewayFetch<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new McpGatewayError("Not authenticated", 401, endpoint);
  }

  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new McpGatewayError(
      `Gateway request failed: ${response.status} ${errorBody}`,
      response.status,
      endpoint,
    );
  }

  return response.json();
}

/**
 * Fetch all active publishers from the gateway.
 */
export async function fetchGatewayPublishers(): Promise<Publisher[]> {
  return withRetry(async () => {
    const publishers = await gatewayFetch<Publisher[]>("/api/agent/publishers");
    // Filter to only active publishers with MCP endpoints
    return publishers.filter((p) => p.is_active && (p.mcp_endpoint || p.slug));
  });
}

/**
 * Fetch tools for a specific publisher.
 */
export async function fetchPublisherTools(
  publisherSlug: string,
): Promise<McpToolInfo[]> {
  return withRetry(async () => {
    const response = await gatewayFetch<McpToolsResponse>(
      "/api/agent/mcp/tools",
      {
        method: "POST",
        body: JSON.stringify({ publisher: publisherSlug }),
      },
    );
    return response.tools;
  });
}

/**
 * Fetch all tools from all active publishers.
 * Returns tools tagged with their publisher for routing during execution.
 */
export async function fetchAllGatewayTools(): Promise<GatewayTool[]> {
  try {
    const publishers = await fetchGatewayPublishers();
    console.log(`[MCP Gateway] Found ${publishers.length} active publishers`);

    const allTools: GatewayTool[] = [];

    // Fetch tools from each publisher in parallel
    const results = await Promise.allSettled(
      publishers.map(async (publisher) => {
        try {
          const tools = await fetchPublisherTools(publisher.slug);
          return tools.map((tool) => ({
            publisher: publisher.slug,
            publisherName: publisher.name,
            tool,
          }));
        } catch (error) {
          console.warn(
            `[MCP Gateway] Failed to fetch tools from ${publisher.slug}:`,
            error,
          );
          return [];
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        allTools.push(...result.value);
      }
    }

    console.log(`[MCP Gateway] Loaded ${allTools.length} tools total`);
    return allTools;
  } catch (error) {
    console.error("[MCP Gateway] Failed to fetch gateway tools:", error);
    return [];
  }
}

/**
 * Call a tool on a specific publisher.
 */
export async function callGatewayTool(
  publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResponse> {
  return withRetry(async () => {
    return gatewayFetch<McpToolCallResponse>("/api/agent/mcp/call", {
      method: "POST",
      body: JSON.stringify({
        publisher: publisherSlug,
        tool_name: toolName,
        arguments: args,
      }),
    });
  });
}

// Singleton state for caching tools
let cachedTools: GatewayTool[] = [];
let toolsLoaded = false;
let loadingPromise: Promise<void> | null = null;

/**
 * Initialize the gateway by loading all tools.
 * Safe to call multiple times - will only load once.
 */
export async function initializeGateway(): Promise<void> {
  if (toolsLoaded) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    console.log("[MCP Gateway] Initializing...");
    cachedTools = await fetchAllGatewayTools();
    toolsLoaded = true;
    console.log("[MCP Gateway] Initialized with", cachedTools.length, "tools");
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
 * Check if gateway is initialized.
 */
export function isGatewayInitialized(): boolean {
  return toolsLoaded;
}

/**
 * Reset gateway state (for logout).
 */
export function resetGateway(): void {
  cachedTools = [];
  toolsLoaded = false;
  loadingPromise = null;
}

/**
 * Refresh tools from the gateway.
 */
export async function refreshGatewayTools(): Promise<GatewayTool[]> {
  toolsLoaded = false;
  await initializeGateway();
  return cachedTools;
}
