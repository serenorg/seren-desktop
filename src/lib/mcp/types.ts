// ABOUTME: TypeScript type definitions for MCP (Model Context Protocol).
// ABOUTME: Defines all protocol types, JSON-RPC transport types, and configuration interfaces.

// MCP Protocol Types

export interface McpTool {
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

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string } };

export interface McpError {
  code: number;
  message: string;
  data?: unknown;
}

// JSON-RPC types for MCP transport

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: McpError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// MCP Server Configuration Types

/**
 * Server type discriminator.
 * - "local": Spawns a local process with command/args (stdio transport)
 * - "builtin": Built-in remote server (e.g., SerenDB) that uses gateway API
 */
export type McpServerType = "local" | "builtin";

export interface McpServerConfigBase {
  name: string;
  enabled: boolean;
  autoConnect: boolean;
}

export interface McpLocalServerConfig extends McpServerConfigBase {
  type: "local";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpBuiltinServerConfig extends McpServerConfigBase {
  type: "builtin";
  /** Identifier for the builtin server (e.g., "serendb") */
  builtinId: string;
  /** Description shown in UI */
  description?: string;
}

export type McpServerConfig = McpLocalServerConfig | McpBuiltinServerConfig;

/**
 * Type guard for local server config.
 */
export function isLocalServer(config: McpServerConfig): config is McpLocalServerConfig {
  return config.type === "local";
}

/**
 * Type guard for builtin server config.
 */
export function isBuiltinServer(config: McpServerConfig): config is McpBuiltinServerConfig {
  return config.type === "builtin";
}

export interface McpSettings {
  servers: McpServerConfig[];
  defaultTimeout: number; // ms
}

// MCP Connection State

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface McpConnection {
  serverName: string;
  status: McpConnectionStatus;
  capabilities: McpInitializeResult | null;
  tools: McpTool[];
  resources: McpResource[];
  error?: string;
}
