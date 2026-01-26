// ABOUTME: Store for managing MCP tool calls within chat sessions.
// ABOUTME: Tracks pending approvals, executions, and results for AI-requested tools.

import { createStore } from "solid-js/store";
import { mcpClient } from "@/lib/mcp/client";
import type { McpToolCall, McpToolResult } from "@/lib/mcp/types";

export type ToolCallStatus =
  | "pending"
  | "approved"
  | "denied"
  | "executing"
  | "completed"
  | "error"
  | "canceled";

export interface ToolCallRequest {
  id: string;
  serverName: string;
  call: McpToolCall;
  status: ToolCallStatus;
  result?: McpToolResult;
  error?: string;
  createdAt: number;
  completedAt?: number;
  attemptCount?: number;
  maxRetries?: number;
}

interface McpChatState {
  pendingRequests: ToolCallRequest[];
  completedRequests: ToolCallRequest[];
}

const [mcpChatState, setMcpChatState] = createStore<McpChatState>({
  pendingRequests: [],
  completedRequests: [],
});

let requestIdCounter = 0;

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
  return `mcp-${Date.now()}-${++requestIdCounter}`;
}

/**
 * Create a new tool call request from AI.
 * Returns the request ID for tracking.
 */
function createToolCallRequest(serverName: string, call: McpToolCall): string {
  const id = generateRequestId();

  const request: ToolCallRequest = {
    id,
    serverName,
    call,
    status: "pending",
    createdAt: Date.now(),
  };

  setMcpChatState("pendingRequests", (prev) => [...prev, request]);

  return id;
}

/**
 * Find a request by ID.
 */
function findRequest(id: string): ToolCallRequest | undefined {
  return (
    mcpChatState.pendingRequests.find((r) => r.id === id) ||
    mcpChatState.completedRequests.find((r) => r.id === id)
  );
}

/**
 * Update a pending request.
 */
function updatePendingRequest(
  id: string,
  updates: Partial<ToolCallRequest>,
): void {
  setMcpChatState("pendingRequests", (requests) =>
    requests.map((r) => (r.id === id ? { ...r, ...updates } : r)),
  );
}

/**
 * Move a request from pending to completed.
 */
function completeRequest(id: string): void {
  const request = mcpChatState.pendingRequests.find((r) => r.id === id);
  if (!request) return;

  setMcpChatState("pendingRequests", (requests) =>
    requests.filter((r) => r.id !== id),
  );
  setMcpChatState("completedRequests", (requests) => [
    ...requests,
    { ...request, completedAt: Date.now() },
  ]);
}

/**
 * Approve and execute a tool call request.
 */
async function approveToolCall(id: string): Promise<McpToolResult> {
  const request = mcpChatState.pendingRequests.find((r) => r.id === id);
  if (!request) {
    throw new Error(`Request ${id} not found`);
  }

  updatePendingRequest(id, { status: "executing" });

  try {
    const result = await mcpClient.callTool(request.serverName, request.call);

    updatePendingRequest(id, {
      status: "completed",
      result,
    });
    completeRequest(id);

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    updatePendingRequest(id, {
      status: "error",
      error: errorMessage,
    });
    completeRequest(id);

    throw error;
  }
}

/**
 * Deny a tool call request.
 */
function denyToolCall(id: string): void {
  updatePendingRequest(id, { status: "denied" });
  completeRequest(id);
}

/**
 * Get all pending tool call requests.
 */
function getPendingRequests(): ToolCallRequest[] {
  return mcpChatState.pendingRequests;
}

/**
 * Get all completed tool call requests.
 */
function getCompletedRequests(): ToolCallRequest[] {
  return mcpChatState.completedRequests;
}

/**
 * Clear completed requests.
 */
function clearCompletedRequests(): void {
  setMcpChatState("completedRequests", []);
}

/**
 * Check if there are any pending approvals.
 */
function hasPendingApprovals(): boolean {
  return mcpChatState.pendingRequests.some((r) => r.status === "pending");
}

/**
 * Get available tools for chat to use.
 * Returns tools grouped by server.
 */
function getAvailableToolsForChat(): Array<{
  serverName: string;
  tools: Array<{ name: string; description: string }>;
}> {
  const result: Array<{
    serverName: string;
    tools: Array<{ name: string; description: string }>;
  }> = [];

  const connections = mcpClient.connections();
  const serverNames = Array.from(connections.keys());

  for (const serverName of serverNames) {
    const conn = connections.get(serverName);
    if (conn && conn.status === "connected") {
      result.push({
        serverName,
        tools: conn.tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      });
    }
  }

  return result;
}

export {
  mcpChatState,
  createToolCallRequest,
  findRequest,
  approveToolCall,
  denyToolCall,
  getPendingRequests,
  getCompletedRequests,
  clearCompletedRequests,
  hasPendingApprovals,
  getAvailableToolsForChat,
};
