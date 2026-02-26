// ABOUTME: Tool executor that routes tool calls to file operations, MCP servers, or gateway.
// ABOUTME: Handles tool call parsing, execution, and result formatting.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mcpClient } from "@/lib/mcp/client";
import type { ToolCall, ToolResult } from "@/lib/providers/types";
import { type PaymentRequirements, parsePaymentRequirements } from "@/lib/x402";
import { callGatewayTool, type PaymentProxyInfo } from "@/services/mcp-gateway";
import { x402Service } from "@/services/x402";
import { getApprovalRequirement, requiresApproval } from "./approval-config";
import {
  parseGatewayToolName,
  parseMcpToolName,
  parseOpenClawToolName,
} from "./definitions";

/**
 * File entry returned by list_directory.
 */
interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

const OPENCLAW_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const GATEWAY_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SHELL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const OPENCLAW_STORE = "openclaw.json";
const MAX_RESULT_SIZE = 50_000; // 50KB cap
const MAX_ARRAY_ITEMS = 25;

/**
 * Check if an error message indicates an OAuth token issue.
 * These errors mean the user's OAuth connection needs to be refreshed.
 */
function isOAuthTokenError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("oauth token refresh failed") ||
    lowerMessage.includes("token refresh failed") ||
    lowerMessage.includes("provider error during token refresh") ||
    lowerMessage.includes("oauth authentication required") ||
    lowerMessage.includes("invalid_grant") ||
    lowerMessage.includes("refresh token expired")
  );
}

/**
 * Emit an event to notify the UI that an OAuth connection has expired.
 * The OAuthLogins component listens for this to update the connection status.
 */
async function notifyOAuthExpired(
  publisherSlug: string,
  errorMessage: string,
): Promise<void> {
  try {
    await emit("oauth-connection-expired", {
      publisherSlug,
      errorMessage,
      timestamp: Date.now(),
    });
    console.log(
      `[Tool Executor] Emitted oauth-connection-expired for ${publisherSlug}`,
    );
  } catch (err) {
    console.error(
      "[Tool Executor] Failed to emit oauth-connection-expired:",
      err,
    );
  }
}

/**
 * Truncate large tool results to prevent overwhelming the AI context and database.
 * For JSON arrays (e.g. email lists), extracts key summary fields per item.
 */
function truncateToolResult(content: string): string {
  if (content.length <= MAX_RESULT_SIZE) return content;

  // Try to detect JSON array results (emails, records, etc.)
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed) && parsed.length > MAX_ARRAY_ITEMS) {
      const total = parsed.length;
      const summary = parsed.slice(0, MAX_ARRAY_ITEMS).map((item: unknown) => {
        if (typeof item === "object" && item !== null) {
          const record = item as Record<string, unknown>;
          const keys = Object.keys(record);
          const summaryKeys = [
            "id",
            "subject",
            "title",
            "name",
            "from",
            "sender",
            "date",
            "timestamp",
            "created_at",
            "snippet",
            "status",
            "type",
          ];
          const kept: Record<string, unknown> = {};
          for (const k of keys) {
            const val = record[k];
            if (
              summaryKeys.includes(k.toLowerCase()) ||
              typeof val !== "string" ||
              val.length < 200
            ) {
              kept[k] =
                typeof val === "string" && val.length > 200
                  ? `${val.slice(0, 200)}...`
                  : val;
            }
          }
          return Object.keys(kept).length > 0 ? kept : item;
        }
        return item;
      });
      return `${JSON.stringify(summary, null, 2)}\n\n[Showing ${MAX_ARRAY_ITEMS} of ${total} items. Full results truncated.]`;
    }
  } catch {
    // Not JSON, fall through to plain text truncation
  }

  return `${content.slice(0, MAX_RESULT_SIZE)}\n\n[Truncated: result was ${content.length.toLocaleString()} characters]`;
}

function parseOpenClawApprovalError(
  message: string,
): { approvalId: string } | null {
  const trimmed = message.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart === -1) return null;
  const json = trimmed.slice(jsonStart);
  try {
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === "object" &&
      parsed != null &&
      "code" in parsed &&
      (parsed as { code?: unknown }).code === "approval_required" &&
      "approvalId" in parsed
    ) {
      const approvalId = (parsed as { approvalId?: unknown }).approvalId;
      if (typeof approvalId === "string" && approvalId.length > 0) {
        return { approvalId };
      }
    }
  } catch {
    // Not JSON
  }
  return null;
}

async function waitForOpenClawApproval(approvalId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let unlisten: UnlistenFn | undefined;
    const timeout = setTimeout(() => {
      unlisten?.();
      resolve(false);
    }, OPENCLAW_APPROVAL_TIMEOUT_MS);

    listen<{ id: string; approved: boolean }>(
      "openclaw://approval-response",
      (event) => {
        if (event.payload.id !== approvalId) return;
        clearTimeout(timeout);
        unlisten?.();
        resolve(event.payload.approved);
      },
    )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        clearTimeout(timeout);
        resolve(false);
      });
  });
}

async function ensureOpenClawRunning(): Promise<{
  started: boolean;
  alreadyRunning: boolean;
}> {
  try {
    await invoke("openclaw_start");
    return { started: true, alreadyRunning: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("already running")) {
      return { started: false, alreadyRunning: true };
    }
    throw error;
  }
}

/**
 * Request user approval for a Gateway tool operation.
 * Returns a promise that resolves to true if approved, false if denied or timeout.
 */
async function requestGatewayApproval(
  publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const approvalId = `gateway-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const requirement = getApprovalRequirement(publisherSlug, toolName);

  console.log(
    `[Tool Executor] Requesting approval for ${publisherSlug}/${toolName} (ID: ${approvalId})`,
  );

  // Emit approval request event for UI to display
  try {
    await emit("gateway-tool-approval-request", {
      approvalId,
      publisherSlug,
      toolName,
      args,
      description: requirement?.description || "Execute operation",
      isDestructive: requirement?.isDestructive || false,
    });
  } catch (err) {
    console.error("[Tool Executor] Failed to emit approval request:", err);
    return false;
  }

  // Wait for approval response
  return new Promise((resolve) => {
    let unlisten: UnlistenFn | undefined;
    const timeout = setTimeout(() => {
      console.log(`[Tool Executor] Approval timeout for ${approvalId}`);
      unlisten?.();
      resolve(false);
    }, GATEWAY_APPROVAL_TIMEOUT_MS);

    listen<{ id: string; approved: boolean }>(
      "gateway-tool-approval-response",
      (event) => {
        if (event.payload.id !== approvalId) return;
        console.log(
          `[Tool Executor] Received approval response: ${event.payload.approved}`,
        );
        clearTimeout(timeout);
        unlisten?.();
        resolve(event.payload.approved);
      },
    )
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("[Tool Executor] Failed to listen for approval:", err);
        clearTimeout(timeout);
        resolve(false);
      });
  });
}

/**
 * Request user approval for a shell command execution.
 * All shell commands require approval — there is no bypass.
 */
async function requestShellApproval(
  command: string,
  timeoutSecs: number,
): Promise<boolean> {
  const approvalId = `shell-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  console.log(
    `[Tool Executor] Requesting shell approval (ID: ${approvalId}): ${command}`,
  );

  try {
    await emit("shell-command-approval-request", {
      approvalId,
      command,
      timeoutSecs,
    });
  } catch (err) {
    console.error(
      "[Tool Executor] Failed to emit shell approval request:",
      err,
    );
    return false;
  }

  return new Promise((resolve) => {
    let unlisten: UnlistenFn | undefined;
    const timeout = setTimeout(() => {
      console.log(`[Tool Executor] Shell approval timeout for ${approvalId}`);
      unlisten?.();
      resolve(false);
    }, SHELL_APPROVAL_TIMEOUT_MS);

    listen<{ id: string; approved: boolean }>(
      "shell-command-approval-response",
      (event) => {
        if (event.payload.id !== approvalId) return;
        console.log(
          `[Tool Executor] Shell approval response: ${event.payload.approved}`,
        );
        clearTimeout(timeout);
        unlisten?.();
        resolve(event.payload.approved);
      },
    )
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error(
          "[Tool Executor] Failed to listen for shell approval:",
          err,
        );
        clearTimeout(timeout);
        resolve(false);
      });
  });
}

/**
 * Execute a single tool call and return the result.
 * Routes to MCP servers or file tools based on prefix.
 */
export async function executeTool(toolCall: ToolCall): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function;

  try {
    const args = (argsJson ? JSON.parse(argsJson) : {}) as Record<
      string,
      unknown
    >;

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

    // Check if this is an OpenClaw tool call (openclaw__toolName)
    const openclawInfo = parseOpenClawToolName(name);
    if (openclawInfo) {
      return await executeOpenClawTool(
        toolCall.id,
        openclawInfo.toolName,
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

      case "seren_web_fetch": {
        const url = args.url as string;
        const timeoutMs = args.timeout_ms as number | undefined;
        const response = await invoke<{
          content: string;
          content_type: string;
          url: string;
          status: number;
          truncated: boolean;
        }>("web_fetch", { url, timeoutMs });

        if (response.status >= 400) {
          result = `Error: HTTP ${response.status} for ${response.url}`;
        } else {
          result = response.content;
        }
        break;
      }

      case "execute_command": {
        const command = args.command as string;
        if (!command || typeof command !== "string") {
          throw new Error("Invalid command: must be a non-empty string");
        }
        const timeoutSecs = (args.timeout_secs as number) ?? 30;

        const approved = await requestShellApproval(command, timeoutSecs);
        if (!approved) {
          return {
            tool_call_id: toolCall.id,
            content: "Command was not approved by user",
            is_error: true,
          };
        }

        const cmdResult = await invoke<{
          stdout: string;
          stderr: string;
          exit_code: number | null;
          timed_out: boolean;
        }>("execute_shell_command", { command, timeoutSecs });

        if (cmdResult.timed_out) {
          result = `Command timed out after ${timeoutSecs} seconds.\nstderr: ${cmdResult.stderr}`;
        } else {
          const parts: string[] = [];
          if (cmdResult.stdout) parts.push(`stdout:\n${cmdResult.stdout}`);
          if (cmdResult.stderr) parts.push(`stderr:\n${cmdResult.stderr}`);
          parts.push(`exit_code: ${cmdResult.exit_code ?? "unknown"}`);
          result = parts.join("\n\n");
        }
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    const resultContent =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return {
      tool_call_id: toolCall.id,
      content: truncateToolResult(resultContent),
      is_error: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Tool Executor] Tool "${name}" failed:`, message);
    return {
      tool_call_id: toolCall.id,
      content: `Error: ${message}`,
      is_error: true,
    };
  }
}

/**
 * Execute an OpenClaw tool call via Tauri IPC.
 */
async function executeOpenClawTool(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case "start": {
        const start = await ensureOpenClawRunning();
        const status = await invoke<{
          processStatus: string;
          port: number | null;
          channels: Array<{
            id: string;
            platform: string;
            displayName: string;
            status: string;
          }>;
          uptimeSecs: number | null;
        }>("openclaw_status");
        return {
          tool_call_id: toolCallId,
          content: JSON.stringify(
            {
              ok: true,
              ...start,
              status,
            },
            null,
            2,
          ),
          is_error: false,
        };
      }
      case "setup_discord": {
        const botToken = args.bot_token as string;
        if (!botToken || typeof botToken !== "string") {
          return {
            tool_call_id: toolCallId,
            content: "Missing required parameter: bot_token",
            is_error: true,
          };
        }

        const start = await ensureOpenClawRunning();
        const connectResult = await invoke<Record<string, unknown>>(
          "openclaw_connect_channel",
          {
            platform: "discord",
            credentials: { botToken },
          },
        );

        await invoke("set_setting", {
          store: OPENCLAW_STORE,
          key: "setup_complete",
          value: "true",
        });

        let channels: Array<{
          id: string;
          platform: string;
          displayName: string;
          status: string;
        }> = [];
        try {
          channels = await invoke<
            Array<{
              id: string;
              platform: string;
              displayName: string;
              status: string;
            }>
          >("openclaw_list_channels");
        } catch {
          // Best-effort refresh only
        }

        return {
          tool_call_id: toolCallId,
          content: JSON.stringify(
            {
              ok: true,
              start,
              setupComplete: true,
              connectResult,
              channels,
            },
            null,
            2,
          ),
          is_error: false,
        };
      }
      case "connect_channel": {
        const platform = args.platform as string;
        const rawCredentials = args.credentials as unknown;
        if (!platform || typeof platform !== "string") {
          return {
            tool_call_id: toolCallId,
            content: "Missing required parameter: platform",
            is_error: true,
          };
        }
        if (
          typeof rawCredentials !== "object" ||
          rawCredentials == null ||
          Array.isArray(rawCredentials)
        ) {
          return {
            tool_call_id: toolCallId,
            content:
              "Missing or invalid required parameter: credentials (object)",
            is_error: true,
          };
        }

        const credentials: Record<string, string> = {};
        for (const [key, value] of Object.entries(
          rawCredentials as Record<string, unknown>,
        )) {
          if (typeof value === "string") {
            credentials[key] = value;
          }
        }
        if (Object.keys(credentials).length === 0) {
          return {
            tool_call_id: toolCallId,
            content:
              "Invalid credentials: provide at least one string credential field",
            is_error: true,
          };
        }

        const start = await ensureOpenClawRunning();
        const connectResult = await invoke<Record<string, unknown>>(
          "openclaw_connect_channel",
          {
            platform,
            credentials,
          },
        );
        return {
          tool_call_id: toolCallId,
          content: JSON.stringify(
            {
              ok: true,
              start,
              connectResult,
            },
            null,
            2,
          ),
          is_error: false,
        };
      }
      case "launch_channel_login": {
        const platform = args.platform as string;
        if (!platform || typeof platform !== "string") {
          return {
            tool_call_id: toolCallId,
            content: "Missing required parameter: platform",
            is_error: true,
          };
        }
        await ensureOpenClawRunning();
        await invoke("openclaw_launch_channel_login", {
          platform,
        });
        return {
          tool_call_id: toolCallId,
          content: `Launched terminal login for platform "${platform}".`,
          is_error: false,
        };
      }
      case "complete_setup": {
        await invoke("set_setting", {
          store: OPENCLAW_STORE,
          key: "setup_complete",
          value: "true",
        });
        return {
          tool_call_id: toolCallId,
          content: "OpenClaw setup marked complete.",
          is_error: false,
        };
      }
      case "send_message": {
        const channel = args.channel as string;
        const to = args.to as string;
        const message = args.message as string;
        if (!channel || !to || !message) {
          return {
            tool_call_id: toolCallId,
            content: "Missing required parameters: channel, to, message",
            is_error: true,
          };
        }
        let result: string;
        try {
          result = await invoke<string>("openclaw_send", {
            channel,
            to,
            message,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const approval = parseOpenClawApprovalError(errorMessage);
          if (!approval) throw error;

          const approved = await waitForOpenClawApproval(approval.approvalId);
          if (!approved) {
            return {
              tool_call_id: toolCallId,
              content: "Message was not approved.",
              is_error: true,
            };
          }

          result = await invoke<string>("openclaw_send", {
            channel,
            to,
            message,
          });
        }
        return {
          tool_call_id: toolCallId,
          content: result || "Message sent successfully.",
          is_error: false,
        };
      }
      case "list_channels": {
        const channels = await invoke<
          Array<{
            id: string;
            platform: string;
            displayName: string;
            status: string;
          }>
        >("openclaw_list_channels");
        return {
          tool_call_id: toolCallId,
          content: JSON.stringify(channels, null, 2),
          is_error: false,
        };
      }
      case "channel_status": {
        const channelId = args.channel as string;
        if (!channelId) {
          return {
            tool_call_id: toolCallId,
            content: "Missing required parameter: channel",
            is_error: true,
          };
        }
        const allChannels = await invoke<
          Array<{
            id: string;
            platform: string;
            displayName: string;
            status: string;
          }>
        >("openclaw_list_channels");
        const found = allChannels.find((c) => c.id === channelId);
        if (!found) {
          return {
            tool_call_id: toolCallId,
            content: `Channel not found: ${channelId}`,
            is_error: true,
          };
        }
        return {
          tool_call_id: toolCallId,
          content: JSON.stringify(found, null, 2),
          is_error: false,
        };
      }
      default:
        return {
          tool_call_id: toolCallId,
          content: `Unknown OpenClaw tool: ${toolName}`,
          is_error: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[Tool Executor] OpenClaw tool "${toolName}" failed:`,
      message,
    );
    return {
      tool_call_id: toolCallId,
      content: `OpenClaw tool error: ${message}`,
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
      content: truncateToolResult(content || "Tool executed successfully"),
      is_error: result.isError ?? false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[Tool Executor] MCP tool "${serverName}/${toolName}" failed:`,
      message,
    );
    return {
      tool_call_id: toolCallId,
      content: `MCP tool error: ${message}`,
      is_error: true,
    };
  }
}

/**
 * Extract PaymentRequirements from proxy payment info.
 */
function extractPaymentRequirements(
  proxyInfo: PaymentProxyInfo,
): PaymentRequirements | null {
  // Try parsing from payment_requirements first (the body JSON)
  if (proxyInfo.payment_requirements) {
    try {
      return parsePaymentRequirements(
        JSON.stringify(proxyInfo.payment_requirements),
      );
    } catch {
      // Fall through to try header
    }
  }

  // Try parsing from the PAYMENT-REQUIRED header (base64-encoded)
  if (proxyInfo.payment_required_header) {
    try {
      const decoded = atob(proxyInfo.payment_required_header);
      return parsePaymentRequirements(decoded);
    } catch {
      // Failed to decode/parse header
    }
  }

  return null;
}

/**
 * Execute a gateway tool call via the MCP Gateway.
 * Handles x402 payment proxy flow: if server returns payment requirements,
 * signs the payment locally and retries with _x402_payment parameter.
 */
async function executeGatewayTool(
  toolCallId: string,
  publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    // Check if this operation requires user approval
    if (requiresApproval(publisherSlug, toolName)) {
      console.log(
        `[Tool Executor] Operation requires approval: ${publisherSlug}/${toolName}`,
      );
      const approved = await requestGatewayApproval(
        publisherSlug,
        toolName,
        args,
      );

      if (!approved) {
        console.log("[Tool Executor] Operation denied by user");
        return {
          tool_call_id: toolCallId,
          content: "Operation was not approved by user",
          is_error: true,
        };
      }

      console.log("[Tool Executor] Operation approved by user");
    }

    const response = await callGatewayTool(publisherSlug, toolName, args);

    // Check if this is a payment proxy response (requires client-side signing)
    if (response.is_error && response.payment_proxy) {
      console.log(
        "[Tool Executor] Payment proxy detected, attempting local signing...",
      );

      const requirements = extractPaymentRequirements(response.payment_proxy);
      if (!requirements) {
        return {
          tool_call_id: toolCallId,
          content:
            "Payment required but could not parse payment requirements from server response",
          is_error: true,
        };
      }

      // Use the x402 service to handle payment (shows UI, signs, etc.)
      const paymentResult = await x402Service.handlePaymentRequired(
        `seren-gateway/${publisherSlug}`,
        toolName,
        new Error(JSON.stringify(response.payment_proxy)),
      );

      if (!paymentResult || !paymentResult.success) {
        return {
          tool_call_id: toolCallId,
          content: paymentResult?.error || "Payment was cancelled or failed",
          is_error: true,
        };
      }

      // If crypto payment was signed, retry with the payment header
      if (paymentResult.paymentHeader) {
        console.log("[Tool Executor] Retrying with signed payment...");

        const retryArgs = {
          ...args,
          _x402_payment: paymentResult.paymentHeader,
        };

        const retryResponse = await callGatewayTool(
          publisherSlug,
          toolName,
          retryArgs,
        );

        const retryContent =
          typeof retryResponse.result === "string"
            ? retryResponse.result
            : JSON.stringify(retryResponse.result, null, 2);

        return {
          tool_call_id: toolCallId,
          content: truncateToolResult(
            retryContent || "Tool executed successfully with payment",
          ),
          is_error: retryResponse.is_error,
        };
      }

      // SerenBucks payment - server handles it via auth token
      // Just retry the original call (auth token is always sent)
      if (paymentResult.method === "serenbucks") {
        console.log(
          "[Tool Executor] SerenBucks selected, retrying (server uses auth token)...",
        );

        // For SerenBucks, we might need to add a flag to indicate user confirmed
        // For now, just retry - the server should accept prepaid if available
        const retryResponse = await callGatewayTool(
          publisherSlug,
          toolName,
          args,
        );

        const retryContent =
          typeof retryResponse.result === "string"
            ? retryResponse.result
            : JSON.stringify(retryResponse.result, null, 2);

        return {
          tool_call_id: toolCallId,
          content: truncateToolResult(
            retryContent || "Tool executed successfully",
          ),
          is_error: retryResponse.is_error,
        };
      }
    }

    // Convert result to string content
    const content =
      typeof response.result === "string"
        ? response.result
        : JSON.stringify(response.result, null, 2);

    // Check for OAuth token errors in the response
    if (response.is_error && isOAuthTokenError(content)) {
      notifyOAuthExpired(publisherSlug, content);
    }

    return {
      tool_call_id: toolCallId,
      content: truncateToolResult(content || "Tool executed successfully"),
      is_error: response.is_error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[Tool Executor] Gateway tool "${publisherSlug}/${toolName}" failed:`,
      message,
    );

    // Check for OAuth token errors and notify the UI
    if (isOAuthTokenError(message)) {
      notifyOAuthExpired(publisherSlug, message);
    }

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
