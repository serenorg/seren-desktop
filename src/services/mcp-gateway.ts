// ABOUTME: MCP Gateway service for fetching tools from Seren publishers via REST API.
// ABOUTME: Replaces the Node.js bridge with direct HTTP calls to api.serendb.com.

import { appFetch } from "@/lib/fetch";
import { getApiKey } from "./auth";

const API_BASE = "https://api.serendb.com";

// Cache configuration
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Concurrency limit to avoid overwhelming the backend
// Set to 3 - loads in background so doesn't block user, but still gentle on backend
// TODO: Increase when backend is fixed (see serenorg/seren#95)
const MAX_CONCURRENT_REQUESTS = 3;

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
 * Process items with limited concurrency to avoid overwhelming the backend.
 * Uses a simple chunking approach - process N items at a time.
 */
async function processInBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  batchSize: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults);
  }

  return results;
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
 * Accepts an optional pre-fetched apiKey to avoid redundant auth calls during batch operations.
 */
async function gatewayFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  apiKey?: string,
): Promise<T> {
  const key = apiKey ?? (await getApiKey());
  if (!key) {
    throw new McpGatewayError("Not authenticated", 401, endpoint);
  }

  const url = `${API_BASE}${endpoint}`;
  const response = await appFetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
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
 * Response shape from /agent/publishers (paginated).
 */
interface PaginatedPublishersResponse {
  data: Publisher[];
  pagination: { offset: number; limit: number; total: number };
}

/**
 * Fetch all active publishers from the gateway (handles pagination).
 * Accepts optional apiKey to avoid redundant auth calls during batch operations.
 */
export async function fetchGatewayPublishers(
  apiKey?: string,
): Promise<Publisher[]> {
  return withRetry(async () => {
    const allPublishers: Publisher[] = [];
    let offset = 0;
    const limit = 100; // Fetch in batches of 100

    while (true) {
      const response = await gatewayFetch<PaginatedPublishersResponse>(
        `/agent/publishers?offset=${offset}&limit=${limit}`,
        {},
        apiKey,
      );
      allPublishers.push(...response.data);

      // Check if we've fetched all publishers
      if (
        response.data.length < limit ||
        allPublishers.length >= response.pagination.total
      ) {
        break;
      }
      offset += limit;
    }

    // Return all active publishers - backend handles routing to databases, APIs, services, and MCP servers
    return allPublishers.filter((p) => p.is_active);
  });
}

/**
 * Fetch tools for a specific publisher.
 * Accepts optional apiKey to avoid redundant auth calls during batch operations.
 */
export async function fetchPublisherTools(
  publisherSlug: string,
  apiKey?: string,
): Promise<McpToolInfo[]> {
  return withRetry(async () => {
    const response = await gatewayFetch<McpToolsResponse>(
      "/agent/mcp/tools",
      { method: "POST", body: JSON.stringify({ publisher: publisherSlug }) },
      apiKey,
    );
    return response.tools;
  });
}

/**
 * Fetch all tools from all active publishers.
 * Returns tools tagged with their publisher for routing during execution.
 * Fetches the API key once and reuses it for all publisher requests.
 */
export async function fetchAllGatewayTools(): Promise<GatewayTool[]> {
  try {
    // Fetch API key once and reuse for all requests
    const apiKey = await getApiKey();
    if (!apiKey) {
      console.error("[MCP Gateway] Not authenticated - cannot fetch tools");
      return [];
    }

    const publishers = await fetchGatewayPublishers(apiKey);
    console.log(`[MCP Gateway] Found ${publishers.length} active publishers`);

    const allTools: GatewayTool[] = [];
    const errors: { publisher: string; status: number; message: string }[] = [];

    // Fetch tools in batches to avoid overwhelming the backend
    const results = await processInBatches(
      publishers,
      async (publisher) => {
        const tools = await fetchPublisherTools(publisher.slug, apiKey);
        return tools.map((tool) => ({
          publisher: publisher.slug,
          publisherName: publisher.name,
          tool,
        }));
      },
      MAX_CONCURRENT_REQUESTS,
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const publisher = publishers[i];
      if (result.status === "fulfilled") {
        allTools.push(...result.value);
      } else {
        const error = result.reason;
        if (error instanceof McpGatewayError) {
          errors.push({
            publisher: publisher.slug,
            status: error.status,
            message: error.message,
          });
        } else {
          errors.push({
            publisher: publisher.slug,
            status: 0,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Log error summary for debugging
    if (errors.length > 0) {
      console.warn(`[MCP Gateway] ${errors.length} publishers failed`);
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
let cachedPublishers: Publisher[] = [];
let lastFetchedAt: number | null = null;
let loadingPromise: Promise<void> | null = null;

/**
 * Check if the cache is still valid (not expired).
 */
function isCacheValid(): boolean {
  if (!lastFetchedAt || cachedTools.length === 0) return false;
  return Date.now() - lastFetchedAt < CACHE_TTL_MS;
}

/**
 * Initialize the gateway by loading all tools.
 * Safe to call multiple times - uses cached data if still valid.
 * Fetches the API key once and reuses it for all publisher requests.
 */
export async function initializeGateway(): Promise<void> {
  // Return cached data if still valid
  if (isCacheValid()) {
    console.log("[MCP Gateway] Using cached tools (still valid)");
    return;
  }

  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    console.log("[MCP Gateway] Initializing...");

    // Fetch API key once and reuse for all requests
    const apiKey = await getApiKey();
    if (!apiKey) {
      console.error("[MCP Gateway] Not authenticated - cannot initialize");
      return;
    }
    console.log("[MCP Gateway] API key cached for batch requests");

    cachedPublishers = await fetchGatewayPublishers(apiKey);
    console.log(
      `[MCP Gateway] Found ${cachedPublishers.length} active publishers`,
    );

    const allTools: GatewayTool[] = [];
    const errors: { publisher: string; status: number; message: string }[] = [];

    // Fetch tools in batches to avoid overwhelming the backend
    const results = await processInBatches(
      cachedPublishers,
      async (publisher) => {
        const tools = await fetchPublisherTools(publisher.slug, apiKey);
        return tools.map((tool) => ({
          publisher: publisher.slug,
          publisherName: publisher.name,
          tool,
        }));
      },
      MAX_CONCURRENT_REQUESTS,
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const publisher = cachedPublishers[i];
      if (result.status === "fulfilled") {
        allTools.push(...result.value);
      } else {
        const error = result.reason;
        if (error instanceof McpGatewayError) {
          errors.push({
            publisher: publisher.slug,
            status: error.status,
            message: error.message,
          });
        } else {
          errors.push({
            publisher: publisher.slug,
            status: 0,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Log error summary for debugging
    if (errors.length > 0) {
      const byStatus = errors.reduce(
        (acc, e) => {
          acc[e.status] = (acc[e.status] || 0) + 1;
          return acc;
        },
        {} as Record<number, number>,
      );
      console.warn(
        `[MCP Gateway] ${errors.length} publishers failed:`,
        Object.entries(byStatus)
          .map(([status, count]) => `${status}: ${count}`)
          .join(", "),
      );
      errors.slice(0, 3).forEach((e) => {
        console.warn(`  - ${e.publisher}: ${e.status} ${e.message}`);
      });
      if (errors.length > 3) {
        console.warn(`  ... and ${errors.length - 3} more`);
      }
    }

    cachedTools = allTools;
    lastFetchedAt = Date.now();
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
 * Check if gateway is initialized with valid cache.
 */
export function isGatewayInitialized(): boolean {
  return isCacheValid();
}

/**
 * Reset gateway state (for logout).
 */
export function resetGateway(): void {
  cachedTools = [];
  cachedPublishers = [];
  lastFetchedAt = null;
  loadingPromise = null;
}

/**
 * Force refresh tools from the gateway (bypasses TTL).
 */
export async function refreshGatewayTools(): Promise<GatewayTool[]> {
  lastFetchedAt = null; // Invalidate cache
  await initializeGateway();
  return cachedTools;
}

/**
 * Get cached publishers (available after initialization).
 */
export function getGatewayPublishers(): Publisher[] {
  return cachedPublishers;
}

/**
 * Get cache age in milliseconds, or null if not cached.
 */
export function getCacheAge(): number | null {
  return lastFetchedAt ? Date.now() - lastFetchedAt : null;
}
