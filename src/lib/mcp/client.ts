// ABOUTME: MCP client service for frontend communication with MCP servers.
// ABOUTME: Provides reactive state management and Tauri IPC integration.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { isRecoverableError, parseMcpError } from "./errors";
import type {
  McpConnection,
  McpConnectionStatus,
  McpInitializeResult,
  McpResource,
  McpTool,
  McpToolCall,
  McpToolResult,
} from "./types";

/**
 * Create an MCP client with reactive state management.
 */
function createMcpClient() {
  const [connections, setConnections] = createSignal<
    Map<string, McpConnection>
  >(new Map());

  /**
   * Get a connection by server name.
   */
  function getConnection(serverName: string): McpConnection | undefined {
    return connections().get(serverName);
  }

  /**
   * Update a connection's state.
   */
  function updateConnection(
    serverName: string,
    updates: Partial<McpConnection>,
  ): void {
    setConnections((prev) => {
      const next = new Map(prev);
      const existing = next.get(serverName);
      if (existing) {
        next.set(serverName, { ...existing, ...updates });
      }
      return next;
    });
  }

  /**
   * Set a connection's status.
   */
  function setConnectionStatus(
    serverName: string,
    status: McpConnectionStatus,
    error?: string,
  ): void {
    updateConnection(serverName, { status, error });
  }

  /**
   * Connect to an MCP server.
   */
  async function connect(
    serverName: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<void> {
    // Initialize connection state
    setConnections((prev) => {
      const next = new Map(prev);
      next.set(serverName, {
        serverName,
        status: "connecting",
        capabilities: null,
        tools: [],
        resources: [],
      });
      return next;
    });

    try {
      // Connect via Tauri
      const result = await invoke<McpInitializeResult>("mcp_connect", {
        serverName,
        command,
        args,
        env: env || null,
      });

      // Fetch tools and resources
      const [tools, resources] = await Promise.all([
        listTools(serverName),
        listResources(serverName),
      ]);

      // Update connection state
      setConnections((prev) => {
        const next = new Map(prev);
        next.set(serverName, {
          serverName,
          status: "connected",
          capabilities: result,
          tools,
          resources,
        });
        return next;
      });
    } catch (error) {
      setConnectionStatus(
        serverName,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async function disconnect(serverName: string): Promise<void> {
    try {
      await invoke("mcp_disconnect", { serverName });
    } finally {
      setConnections((prev) => {
        const next = new Map(prev);
        next.delete(serverName);
        return next;
      });
    }
  }

  /**
   * List tools available on an MCP server.
   */
  async function listTools(serverName: string): Promise<McpTool[]> {
    return invoke<McpTool[]>("mcp_list_tools", { serverName });
  }

  /**
   * List resources available on an MCP server.
   */
  async function listResources(serverName: string): Promise<McpResource[]> {
    return invoke<McpResource[]>("mcp_list_resources", { serverName });
  }

  /**
   * Call a tool on an MCP server.
   */
  type CallToolOptions = {
    signal?: AbortSignal;
  };

  type RetryToolOptions = CallToolOptions & {
    maxAttempts?: number;
    initialDelayMs?: number;
    onAttempt?: (attempt: number) => void;
  };

  function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return promise;
    }

    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Operation aborted", "AbortError"),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Operation aborted", "AbortError"));
      };

      signal.addEventListener("abort", onAbort);

      promise
        .then((value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        })
        .catch((error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        });
    });
  }

  async function callTool(
    serverName: string,
    call: McpToolCall,
    options?: CallToolOptions,
  ): Promise<McpToolResult> {
    const invocation = invoke<McpToolResult>("mcp_call_tool", {
      serverName,
      toolName: call.name,
      arguments: call.arguments,
    }).catch((error) => {
      throw parseMcpError(error, serverName);
    });

    return withAbort(invocation, options?.signal);
  }

  async function retryToolCall(
    serverName: string,
    call: McpToolCall,
    options?: RetryToolOptions,
  ): Promise<McpToolResult> {
    const maxAttempts = options?.maxAttempts ?? 3;
    let delay = options?.initialDelayMs ?? 1000;
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      options?.onAttempt?.(attempt);

      try {
        return await callTool(serverName, call, { signal: options?.signal });
      } catch (error) {
        lastError = error;

        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }

        if (!isRecoverableError(error) || attempt >= maxAttempts) {
          throw error;
        }

        await waitWithAbort(delay, options?.signal);
        delay *= 2;
      }
    }

    throw lastError ?? new Error("Tool call failed");
  }

  function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Operation aborted", "AbortError"),
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Operation aborted", "AbortError"));
      };

      signal.addEventListener("abort", onAbort);
    });
  }

  /**
   * Read a resource from an MCP server.
   */
  async function readResource(
    serverName: string,
    uri: string,
  ): Promise<unknown> {
    return invoke("mcp_read_resource", { serverName, uri });
  }

  /**
   * Check if an MCP server is connected.
   */
  async function isConnected(serverName: string): Promise<boolean> {
    return invoke<boolean>("mcp_is_connected", { serverName });
  }

  /**
   * Get list of connected MCP servers.
   */
  async function listConnected(): Promise<string[]> {
    return invoke<string[]>("mcp_list_connected");
  }

  /**
   * Refresh tools for a connected server.
   */
  async function refreshTools(serverName: string): Promise<McpTool[]> {
    const tools = await listTools(serverName);
    updateConnection(serverName, { tools });
    return tools;
  }

  /**
   * Refresh resources for a connected server.
   */
  async function refreshResources(serverName: string): Promise<McpResource[]> {
    const resources = await listResources(serverName);
    updateConnection(serverName, { resources });
    return resources;
  }

  /**
   * Get all tools across all connected servers.
   */
  function getAllTools(): Array<{ serverName: string; tool: McpTool }> {
    const result: Array<{ serverName: string; tool: McpTool }> = [];
    const conns = Array.from(connections().values());
    for (const conn of conns) {
      if (conn.status === "connected") {
        for (const tool of conn.tools) {
          result.push({ serverName: conn.serverName, tool });
        }
      }
    }
    return result;
  }

  /**
   * Get all resources across all connected servers.
   */
  function getAllResources(): Array<{
    serverName: string;
    resource: McpResource;
  }> {
    const result: Array<{ serverName: string; resource: McpResource }> = [];
    const conns = Array.from(connections().values());
    for (const conn of conns) {
      if (conn.status === "connected") {
        for (const resource of conn.resources) {
          result.push({ serverName: conn.serverName, resource });
        }
      }
    }
    return result;
  }

  return {
    connections,
    getConnection,
    connect,
    disconnect,
    listTools,
    listResources,
    callTool,
    retryToolCall,
    readResource,
    isConnected,
    listConnected,
    refreshTools,
    refreshResources,
    getAllTools,
    getAllResources,
  };
}

// Export singleton instance
export const mcpClient = createMcpClient();

// Re-export for convenience
export type { McpConnection } from "./types";
