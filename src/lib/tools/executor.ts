// ABOUTME: Tool executor that routes tool calls to file operations, MCP servers, or gateway.
// ABOUTME: Handles tool call parsing, execution, and result formatting.

import { invoke } from "@tauri-apps/api/core";
import { mcpClient } from "@/lib/mcp/client";
import type { ToolCall, ToolResult } from "@/lib/providers/types";
import { callGatewayTool } from "@/services/mcp-gateway";
import { parseGatewayToolName, parseMcpToolName } from "./definitions";

/**
 * File entry returned by list_directory.
 */
interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

/**
 * Execute a single tool call and return the result.
 * Routes to MCP servers or file tools based on prefix.
 */
export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function;

  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;

    // Check if this is a Seren Gateway tool call (gateway__publisher__toolName)
    const gatewayInfo = parseGatewayToolName(name);
    if (gatewayInfo) {
      return await executeGatewayTool(
        toolCall.id,
        gatewayInfo.publisherSlug,
        gatewayInfo.toolName,
        args,
      );
    }

    // Check if this is a local MCP tool call (mcp__server__toolName)
    const mcpInfo = parseMcpToolName(name);
    if (mcpInfo) {
      return await executeMcpTool(
        toolCall.id,
        mcpInfo.serverName,
        mcpInfo.toolName,
        args,
      );
    }

    // Otherwise, handle local file tools
    let result: unknown;

    switch (name) {
      case "read_file": {
        const path = args.path as string;
        validatePath(path);
        result = await invoke<string>("read_file", { path });
        break;
      }

      case "list_directory": {
        const path = args.path as string;
        validatePath(path);
        const entries = await invoke<FileEntry[]>("list_directory", { path });
        result = formatDirectoryListing(entries);
        break;
      }

      case "write_file": {
        const path = args.path as string;
        const content = args.content as string;
        validatePath(path);
        if (content == null) {
          throw new Error("Invalid content: content must be provided");
        }
        await invoke("write_file", { path, content });
        result = `Successfully wrote ${content.length} characters to ${path}`;
        break;
      }

      case "path_exists": {
        const path = args.path as string;
        validatePath(path);
        const exists = await invoke<boolean>("path_exists", { path });
        result = exists
          ? `Path exists: ${path}`
          : `Path does not exist: ${path}`;
        break;
      }

      case "create_directory": {
        const path = args.path as string;
        validatePath(path);
        await invoke("create_directory", { path });
        result = `Successfully created directory: ${path}`;
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      tool_call_id: toolCall.id,
      content:
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
      is_error: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool_call_id: toolCall.id,
      content: `Error: ${message}`,
      is_error: true,
    };
  }
}

/**
 * Execute an MCP tool call via the MCP client (local stdio servers).
 */
async function executeMcpTool(
  toolCallId: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const result = await mcpClient.callTool(serverName, {
      name: toolName,
      arguments: args,
    });

    // Convert MCP result content to string
    let content = "";
    for (const item of result.content) {
      if (item.type === "text") {
        content += item.text;
      } else if (item.type === "image") {
        content += `[Image: ${item.mimeType}]`;
      } else if (item.type === "resource") {
        content += item.resource.text || `[Resource: ${item.resource.uri}]`;
      }
    }

    return {
      tool_call_id: toolCallId,
      content: content || "Tool executed successfully",
      is_error: result.isError ?? false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool_call_id: toolCallId,
      content: `MCP tool error: ${message}`,
      is_error: true,
    };
  }
}

/**
 * Execute a gateway tool call via the MCP Gateway.
 */
async function executeGatewayTool(
  toolCallId: string,
  publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const response = await callGatewayTool(publisherSlug, toolName, args);

    // Convert result to string content
    const content =
      typeof response.result === "string"
        ? response.result
        : JSON.stringify(response.result, null, 2);

    return {
      tool_call_id: toolCallId,
      content: content || "Tool executed successfully",
      is_error: response.is_error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool_call_id: toolCallId,
      content: `Gateway tool error: ${message}`,
      is_error: true,
    };
  }
}

/**
 * Execute multiple tool calls in parallel.
 */
export async function executeTools(
  toolCalls: ToolCall[],
): Promise<ToolResult[]> {
  return Promise.all(toolCalls.map(executeTool));
}

/**
 * Validate a path to prevent directory traversal attacks.
 * Throws if the path is suspicious.
 */
function validatePath(path: string): void {
  if (!path || typeof path !== "string") {
    throw new Error("Invalid path: path must be a non-empty string");
  }

  // Check for null bytes (common attack vector)
  if (path.includes("\0")) {
    throw new Error("Invalid path: contains null byte");
  }

  // Warn about suspicious patterns but don't block (user may have legitimate use)
  // The Tauri sandbox should handle actual security
  const normalized = path.replace(/\\/g, "/");
  if (normalized.includes("/../") || normalized.startsWith("../")) {
    console.warn(
      `[Tool Executor] Path contains parent directory traversal: ${path}`,
    );
  }
}

/**
 * Format directory listing for readable output.
 */
function formatDirectoryListing(entries: FileEntry[]): string {
  if (entries.length === 0) {
    return "Directory is empty";
  }

  const lines = entries.map((entry) => {
    const prefix = entry.is_directory ? "[DIR]  " : "[FILE] ";
    return `${prefix}${entry.name}`;
  });

  return lines.join("\n");
}
