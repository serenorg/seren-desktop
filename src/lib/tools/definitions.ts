// ABOUTME: Tool definitions combining local file operations, local MCP, and gateway MCP tools.
// ABOUTME: Follows OpenAI function calling format for use with chat completions.

import { mcpClient } from "@/lib/mcp/client";
import type { McpTool } from "@/lib/mcp/types";
import type { ToolDefinition, ToolParameterSchema } from "@/lib/providers/types";
import {
  gatewayMcpClient,
  GATEWAY_MCP_TOOL_PREFIX,
  type GatewayMcpTool,
} from "./gateway-mcp";

/**
 * Prefix added to MCP tool names to identify them during execution.
 * Format: mcp__{serverName}__{toolName}
 */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Parse an MCP tool name to extract server name and original tool name.
 * Returns null if the name is not an MCP tool.
 */
export function parseMcpToolName(
  name: string,
): { serverName: string; toolName: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) {
    return null;
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const separatorIndex = rest.indexOf("__");
  if (separatorIndex === -1) {
    return null;
  }
  return {
    serverName: rest.slice(0, separatorIndex),
    toolName: rest.slice(separatorIndex + 2),
  };
}

/**
 * Convert a local MCP tool to OpenAI function calling format.
 */
function convertMcpToolToDefinition(
  serverName: string,
  tool: McpTool,
): ToolDefinition {
  // Build parameter properties from MCP input schema
  const properties: ToolParameterSchema["properties"] = {};
  if (tool.inputSchema?.properties) {
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
      properties[key] = {
        type: schema.type,
        description: schema.description,
        enum: schema.enum,
      };
    }
  }

  return {
    type: "function",
    function: {
      // Prefix with server name to route during execution
      name: `${MCP_TOOL_PREFIX}${serverName}__${tool.name}`,
      description: tool.description || `MCP tool from ${serverName}`,
      parameters: {
        type: "object",
        properties,
        required: tool.inputSchema?.required,
      },
    },
  };
}

/**
 * Convert a gateway MCP tool to OpenAI function calling format.
 */
function convertGatewayMcpToolToDefinition(
  gatewayTool: GatewayMcpTool,
): ToolDefinition {
  // Build parameter properties from MCP input schema
  const properties: ToolParameterSchema["properties"] = {};
  const inputSchema = gatewayTool.tool.input_schema as {
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
    required?: string[];
  } | undefined;

  if (inputSchema?.properties) {
    for (const [key, schema] of Object.entries(inputSchema.properties)) {
      properties[key] = {
        type: schema.type || "string",
        description: schema.description,
        enum: schema.enum,
      };
    }
  }

  return {
    type: "function",
    function: {
      // Prefix with publisher slug to route through gateway during execution
      name: `${GATEWAY_MCP_TOOL_PREFIX}${gatewayTool.publisherSlug}__${gatewayTool.tool.name}`,
      description:
        gatewayTool.tool.description ||
        `MCP tool from ${gatewayTool.publisherName}`,
      parameters: {
        type: "object",
        properties,
        required: inputSchema?.required,
      },
    },
  };
}

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
 * Get all available tools, including file tools, local MCP, and gateway MCP tools.
 */
export function getAllTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [...FILE_TOOLS];

  // Add tools from connected local MCP servers
  const mcpTools = mcpClient.getAllTools();
  for (const { serverName, tool } of mcpTools) {
    tools.push(convertMcpToolToDefinition(serverName, tool));
  }

  // Add tools from gateway MCP publishers (cached)
  const gatewayTools = gatewayMcpClient.getAllTools();
  for (const gatewayTool of gatewayTools) {
    tools.push(convertGatewayMcpToolToDefinition(gatewayTool));
  }

  return tools;
}

/**
 * Get a tool definition by name.
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return FILE_TOOLS.find((t) => t.function.name === name);
}
