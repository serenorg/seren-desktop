// ABOUTME: Shared identity contract for the Seren MCP server and its registered tool names.
// ABOUTME: Keeps provider configuration and renderer prompt guidance on one namespace source.

export const SEREN_MCP_SERVER_NAME = "seren-mcp";
export const SEREN_MCP_TOOL_PREFIX = `mcp__${SEREN_MCP_SERVER_NAME}__`;

export function serenMcpToolName(toolName) {
  return `${SEREN_MCP_TOOL_PREFIX}${toolName}`;
}
