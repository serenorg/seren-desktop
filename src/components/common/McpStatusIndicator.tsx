// ABOUTME: MCP connection status indicator for the status bar.
// ABOUTME: Shows connected server count and overall MCP health.

import { createMemo, For, Show, type Component } from "solid-js";
import { mcpClient } from "@/lib/mcp/client";
import type { McpConnectionStatus } from "@/lib/mcp/types";
import "./McpStatusIndicator.css";

export const McpStatusIndicator: Component = () => {
  const connections = () => mcpClient.connections();

  const connectionList = createMemo(() => {
    const conns = connections();
    return Array.from(conns.values());
  });

  const connectedCount = createMemo(() =>
    connectionList().filter((c) => c.status === "connected").length
  );

  const hasErrors = createMemo(() =>
    connectionList().some((c) => c.status === "error")
  );

  const isConnecting = createMemo(() =>
    connectionList().some((c) => c.status === "connecting")
  );

  const overallStatus = createMemo((): McpConnectionStatus => {
    if (connectionList().length === 0) return "disconnected";
    if (hasErrors()) return "error";
    if (isConnecting()) return "connecting";
    if (connectedCount() > 0) return "connected";
    return "disconnected";
  });

  const statusIcon = () => {
    switch (overallStatus()) {
      case "connected":
        return "🟢";
      case "connecting":
        return "🟡";
      case "error":
        return "🔴";
      default:
        return "⚪";
    }
  };

  const statusLabel = () => {
    const count = connectedCount();
    const total = connectionList().length;
    if (total === 0) return "MCP: No servers";
    if (count === total) return `MCP: ${count} connected`;
    if (count > 0) return `MCP: ${count}/${total}`;
    return "MCP: Disconnected";
  };

  return (
    <div class="mcp-status-indicator" title={statusLabel()}>
      <span class="status-icon">{statusIcon()}</span>
      <span class="status-label">{statusLabel()}</span>

      <Show when={connectionList().length > 0}>
        <div class="status-dropdown">
          <div class="dropdown-header">MCP Servers</div>
          <For each={connectionList()}>
            {(conn) => (
              <div class="server-status" classList={{ error: conn.status === "error" }}>
                <span class="server-icon">
                  {conn.status === "connected"
                    ? "🟢"
                    : conn.status === "connecting"
                    ? "🟡"
                    : conn.status === "error"
                    ? "🔴"
                    : "⚪"}
                </span>
                <span class="server-name">{conn.serverName}</span>
                <span class="server-tools">{conn.tools.length} tools</span>
                <Show when={conn.error}>
                  <span class="server-error" title={conn.error}>
                    {conn.error}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default McpStatusIndicator;
