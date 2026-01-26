// ABOUTME: Tool definitions for local file operations.
// ABOUTME: Follows OpenAI function calling format for use with chat completions.

import type { ToolDefinition } from "@/lib/providers/types";

/**
 * File operation tools available to the chat AI.
 * These map to Tauri commands in src-tauri/src/files.rs.
 */
export const FILE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file at the given path. Returns the file contents as text.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The absolute or relative path to the file to read",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List all files and subdirectories in a directory. Returns name, path, and whether each entry is a directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "The absolute or relative path to the directory to list",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file, creating it if it doesn't exist or overwriting if it does. Use with caution.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path where the file should be written",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "path_exists",
      description: "Check if a file or directory exists at the given path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to check",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description:
        "Create a new directory at the given path, including any parent directories that don't exist.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path of the directory to create",
          },
        },
        required: ["path"],
      },
    },
  },
];

/**
 * Get all available tools.
 */
export function getAllTools(): ToolDefinition[] {
  return FILE_TOOLS;
}

/**
 * Get a tool definition by name.
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return FILE_TOOLS.find((t) => t.function.name === name);
}
