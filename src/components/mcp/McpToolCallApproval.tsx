// ABOUTME: Component for approving/denying MCP tool calls requested by AI.
// ABOUTME: Shows tool details, arguments, and allows user to confirm execution.

import { createSignal, Show, For, type Component } from "solid-js";
import { mcpClient } from "@/lib/mcp/client";
import type { McpToolCall, McpToolResult } from "@/lib/mcp/types";
import "./McpToolCallApproval.css";

export interface ToolCallRequest {
  id: string;
  serverName: string;
  call: McpToolCall;
  status: "pending" | "approved" | "denied" | "executing" | "completed" | "error";
  result?: McpToolResult;
  error?: string;
}

export interface McpToolCallApprovalProps {
  request: ToolCallRequest;
  onApprove: (id: string, result: McpToolResult) => void;
  onDeny: (id: string) => void;
}

export const McpToolCallApproval: Component<McpToolCallApprovalProps> = (props) => {
  const [isExecuting, setIsExecuting] = createSignal(false);
  const [result, setResult] = createSignal<McpToolResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function handleApprove(): Promise<void> {
    setIsExecuting(true);
    setError(null);

    try {
      const execResult = await mcpClient.callTool(
        props.request.serverName,
        props.request.call
      );
      setResult(execResult);
      props.onApprove(props.request.id, execResult);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    } finally {
      setIsExecuting(false);
    }
  }

  function handleDeny(): void {
    props.onDeny(props.request.id);
  }

  function formatArgValue(value: unknown): string {
    if (typeof value === "string") return `"${value}"`;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    return JSON.stringify(value);
  }

  function formatResult(res: McpToolResult): string {
    return res.content
      .map((c) => {
        if (c.type === "text") {
          return (c as { type: "text"; text: string }).text;
        }
        return JSON.stringify(c, null, 2);
      })
      .join("\n");
  }

  const argEntries = () => Object.entries(props.request.call.arguments);

  return (
    <div class="mcp-tool-call-approval">
      <div class="approval-header">
        <span class="icon">🔧</span>
        <div class="header-content">
          <span class="title">Tool Call Request</span>
          <span class="tool-name">{props.request.call.name}</span>
        </div>
        <span class="server-badge">{props.request.serverName}</span>
      </div>

      <Show when={argEntries().length > 0}>
        <div class="arguments">
          <span class="section-label">Arguments:</span>
          <div class="arg-list">
            <For each={argEntries()}>
              {([key, value]) => (
                <div class="arg-item">
                  <span class="arg-key">{key}:</span>
                  <span class="arg-value">{formatArgValue(value)}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!result() && !error()}>
        <div class="approval-actions">
          <button
            class="btn-approve"
            onClick={handleApprove}
            disabled={isExecuting()}
          >
            {isExecuting() ? "Executing..." : "Approve & Execute"}
          </button>
          <button
            class="btn-deny"
            onClick={handleDeny}
            disabled={isExecuting()}
          >
            Deny
          </button>
        </div>
      </Show>

      <Show when={error()}>
        <div class="execution-error">
          <span class="error-icon">❌</span>
          <span class="error-message">{error()}</span>
        </div>
      </Show>

      <Show when={result()}>
        <div class="execution-result" classList={{ "is-error": result()?.isError }}>
          <span class="result-icon">{result()?.isError ? "⚠️" : "✅"}</span>
          <div class="result-content">
            <pre>{formatResult(result()!)}</pre>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default McpToolCallApproval;
