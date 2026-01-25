// ABOUTME: MCP-specific error types and handling utilities.
// ABOUTME: Provides structured error handling for MCP operations.

/**
 * Base error class for MCP operations.
 */
export class McpError extends Error {
  readonly code: string;
  readonly serverName?: string;
  readonly recoverable: boolean;

  constructor(
    message: string,
    code: string,
    options?: { serverName?: string; recoverable?: boolean; cause?: Error }
  ) {
    super(message, { cause: options?.cause });
    this.name = "McpError";
    this.code = code;
    this.serverName = options?.serverName;
    this.recoverable = options?.recoverable ?? false;
  }
}

/**
 * Error codes for MCP operations.
 */
export const McpErrorCode = {
  // Connection errors
  CONNECTION_FAILED: "MCP_CONNECTION_FAILED",
  CONNECTION_TIMEOUT: "MCP_CONNECTION_TIMEOUT",
  CONNECTION_REFUSED: "MCP_CONNECTION_REFUSED",
  SERVER_NOT_FOUND: "MCP_SERVER_NOT_FOUND",
  SERVER_CRASHED: "MCP_SERVER_CRASHED",

  // Protocol errors
  PROTOCOL_ERROR: "MCP_PROTOCOL_ERROR",
  INVALID_RESPONSE: "MCP_INVALID_RESPONSE",
  INITIALIZATION_FAILED: "MCP_INITIALIZATION_FAILED",

  // Tool errors
  TOOL_NOT_FOUND: "MCP_TOOL_NOT_FOUND",
  TOOL_EXECUTION_FAILED: "MCP_TOOL_EXECUTION_FAILED",
  INVALID_ARGUMENTS: "MCP_INVALID_ARGUMENTS",

  // Resource errors
  RESOURCE_NOT_FOUND: "MCP_RESOURCE_NOT_FOUND",
  RESOURCE_READ_FAILED: "MCP_RESOURCE_READ_FAILED",

  // Configuration errors
  INVALID_CONFIG: "MCP_INVALID_CONFIG",
  MISSING_COMMAND: "MCP_MISSING_COMMAND",

  // Unknown error
  UNKNOWN: "MCP_UNKNOWN_ERROR",
} as const;

export type McpErrorCodeType = (typeof McpErrorCode)[keyof typeof McpErrorCode];

/**
 * Connection-specific error.
 */
export class McpConnectionError extends McpError {
  constructor(
    message: string,
    code: string = McpErrorCode.CONNECTION_FAILED,
    options?: { serverName?: string; cause?: Error }
  ) {
    super(message, code, { ...options, recoverable: true });
    this.name = "McpConnectionError";
  }
}

/**
 * Tool execution error.
 */
export class McpToolError extends McpError {
  readonly toolName: string;

  constructor(
    message: string,
    toolName: string,
    options?: { serverName?: string; code?: string; cause?: Error }
  ) {
    super(message, options?.code || McpErrorCode.TOOL_EXECUTION_FAILED, {
      ...options,
      recoverable: true,
    });
    this.name = "McpToolError";
    this.toolName = toolName;
  }
}

/**
 * Resource error.
 */
export class McpResourceError extends McpError {
  readonly resourceUri: string;

  constructor(
    message: string,
    resourceUri: string,
    options?: { serverName?: string; code?: string; cause?: Error }
  ) {
    super(message, options?.code || McpErrorCode.RESOURCE_READ_FAILED, {
      ...options,
      recoverable: true,
    });
    this.name = "McpResourceError";
    this.resourceUri = resourceUri;
  }
}

/**
 * Parse an unknown error into an McpError.
 */
export function parseMcpError(
  error: unknown,
  serverName?: string
): McpError {
  if (error instanceof McpError) {
    return error;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Connection errors
    if (message.includes("connection refused") || message.includes("econnrefused")) {
      return new McpConnectionError(
        `Connection refused to MCP server`,
        McpErrorCode.CONNECTION_REFUSED,
        { serverName, cause: error }
      );
    }

    if (message.includes("timeout") || message.includes("timed out")) {
      return new McpConnectionError(
        `Connection timed out`,
        McpErrorCode.CONNECTION_TIMEOUT,
        { serverName, cause: error }
      );
    }

    if (message.includes("not found") || message.includes("enoent")) {
      return new McpConnectionError(
        `MCP server command not found`,
        McpErrorCode.SERVER_NOT_FOUND,
        { serverName, cause: error }
      );
    }

    if (message.includes("crashed") || message.includes("exited")) {
      return new McpConnectionError(
        `MCP server process crashed`,
        McpErrorCode.SERVER_CRASHED,
        { serverName, cause: error }
      );
    }

    // Protocol errors
    if (message.includes("invalid json") || message.includes("parse")) {
      return new McpError(
        `Invalid response from MCP server`,
        McpErrorCode.INVALID_RESPONSE,
        { serverName, cause: error, recoverable: false }
      );
    }

    // Default: wrap in McpError
    return new McpError(error.message, McpErrorCode.UNKNOWN, {
      serverName,
      cause: error,
      recoverable: false,
    });
  }

  // Non-Error thrown
  return new McpError(
    String(error),
    McpErrorCode.UNKNOWN,
    { serverName, recoverable: false }
  );
}

/**
 * Get user-friendly error message for display.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof McpError) {
    let message = error.message;
    if (error.serverName) {
      message = `[${error.serverName}] ${message}`;
    }
    return message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Check if an error is recoverable (can be retried).
 */
export function isRecoverableError(error: unknown): boolean {
  if (error instanceof McpError) {
    return error.recoverable;
  }
  return false;
}

/**
 * Format error for logging/telemetry (scrubs sensitive data).
 */
export function formatErrorForLogging(error: unknown): Record<string, unknown> {
  if (error instanceof McpError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      serverName: error.serverName,
      recoverable: error.recoverable,
      stack: error.stack,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}
