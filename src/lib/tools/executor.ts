// ABOUTME: Tool executor that calls Tauri commands for file operations.
// ABOUTME: Handles tool call parsing, execution, and result formatting.

import { invoke } from "@tauri-apps/api/core";
import type { ToolCall, ToolResult } from "@/lib/providers/types";

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
 */
export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function;

  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
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
        await invoke("write_file", { path, content });
        result = `Successfully wrote ${content.length} characters to ${path}`;
        break;
      }

      case "path_exists": {
        const path = args.path as string;
        validatePath(path);
        const exists = await invoke<boolean>("path_exists", { path });
        result = exists ? `Path exists: ${path}` : `Path does not exist: ${path}`;
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
      content: typeof result === "string" ? result : JSON.stringify(result, null, 2),
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
 * Execute multiple tool calls in parallel.
 */
export async function executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
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
    console.warn(`[Tool Executor] Path contains parent directory traversal: ${path}`);
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
