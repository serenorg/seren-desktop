// ABOUTME: MCP connection status indicator for the status bar.
// ABOUTME: Shows connected server count, builtin servers, and overall MCP health.

import { createMemo, For, Show, type Component } from "solid-js";
import { mcpClient } from "@/lib/mcp/client";
import { mcpSettings } from "@/stores/settings.store";
import { isBuiltinServer, type McpConnectionStatus, type McpBuiltinServerConfig } from "@/lib/mcp/types";
import { authStore } from "@/stores/auth.store";
import "./McpStatusIndicator.css";

export const McpStatusIndicator: Component = () => {
  const connections = () => mcpClient.connections();

  // Local MCP server connections (stdio)
  const connectionList = createMemo(() => {
    const conns = connections();
    return Array.from(conns.values());
  });

  // Enabled builtin servers from settings (route through Gateway)
  const builtinServers = createMemo(() => {
    return mcpSettings().servers.filter(
      (s): s is McpBuiltinServerConfig => isBuiltinServer(s) && s.enabled
    );
  });

  const connectedCount = createMemo(() =>
    connectionList().filter((c) => c.status === "connected").length
  );

  // Builtin servers are "connected" when authenticated
  const builtinConnectedCount = createMemo(() =>
    authStore.isAuthenticated ? builtinServers().length : 0
  );

  const totalConnected = createMemo(() =>
    connectedCount() + builtinConnectedCount()
  );

  const totalServers = createMemo(() =>
    connectionList().length + builtinServers().length
  );

  const hasErrors = createMemo(() =>
    connectionList().some((c) => c.status === "error")
  );

  const isConnecting = createMemo(() =>
    connectionList().some((c) => c.status === "connecting")
  );

  const overallStatus = createMemo((): McpConnectionStatus => {
    if (totalServers() === 0) return "disconnected";
    if (hasErrors()) return "error";
    if (isConnecting()) return "connecting";
    if (totalConnected() > 0) return "connected";
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
    const count = totalConnected();
    const total = totalServers();
    if (total === 0) return "MCP: No servers";
    if (count === total) return `MCP: ${count} connected`;
    if (count > 0) return `MCP: ${count}/${total}`;
    return "MCP: Disconnected";
  };

  return (
    <div class="mcp-status-indicator" title={statusLabel()}>
      <span class="status-icon">{statusIcon()}</span>
      <span class="status-label">{statusLabel()}</span>

      <Show when={totalServers() > 0}>
        <div class="status-dropdown">
          <div class="dropdown-header">MCP Servers</div>

          {/* Builtin servers (Gateway) */}
          <For each={builtinServers()}>
            {(server) => (
              <div
                class="server-status"
                classList={{ gateway: true }}
              >
                <span class="server-icon">
                  {authStore.isAuthenticated ? "🟢" : "⚪"}
                </span>
                <span class="server-name">{server.name}</span>
                <span class="server-tools">Gateway</span>
              </div>
            )}
          </For>

          {/* Local MCP servers */}
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
