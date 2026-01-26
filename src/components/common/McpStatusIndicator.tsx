// ABOUTME: MCP connection status indicator for the status bar.
// ABOUTME: Shows connected server count, builtin servers, and overall MCP health.

import { type Component, createMemo, For, Show } from "solid-js";
import { mcpClient } from "@/lib/mcp/client";
import {
  isBuiltinServer,
  type McpBuiltinServerConfig,
  type McpConnectionStatus,
} from "@/lib/mcp/types";
import { authStore } from "@/stores/auth.store";
import { mcpSettings } from "@/stores/settings.store";

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
      (s): s is McpBuiltinServerConfig => isBuiltinServer(s) && s.enabled,
    );
  });

  const connectedCount = createMemo(
    () => connectionList().filter((c) => c.status === "connected").length,
  );

  // Builtin servers are "connected" when authenticated
  const builtinConnectedCount = createMemo(() =>
    authStore.isAuthenticated ? builtinServers().length : 0,
  );

  const totalConnected = createMemo(
    () => connectedCount() + builtinConnectedCount(),
  );

  const totalServers = createMemo(
    () => connectionList().length + builtinServers().length,
  );

  const hasErrors = createMemo(() =>
    connectionList().some((c) => c.status === "error"),
  );

  const isConnecting = createMemo(() =>
    connectionList().some((c) => c.status === "connecting"),
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
    <div
      class="mcp-status-indicator relative flex items-center gap-1.5 py-1 px-2.5 rounded cursor-default text-xs transition-colors duration-150 hover:bg-black/10 group"
      title={statusLabel()}
    >
      <span class="text-[10px]">{statusIcon()}</span>
      <span class="status-label text-secondary-foreground">
        {statusLabel()}
      </span>

      <Show when={totalServers() > 0}>
        <div class="absolute bottom-full right-0 mb-1 min-w-[220px] bg-popover border border-border rounded-lg shadow-lg opacity-0 invisible translate-y-2 transition-all duration-150 z-[1000] group-hover:opacity-100 group-hover:visible group-hover:translate-y-0">
          <div class="py-2.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border">
            MCP Servers
          </div>

          {/* Builtin servers (Gateway) */}
          <For each={builtinServers()}>
            {(server) => (
              <div class="flex items-center gap-2 py-2 px-3 text-xs border-b border-border last:border-b-0">
                <span class="text-[10px] shrink-0">
                  {authStore.isAuthenticated ? "🟢" : "⚪"}
                </span>
                <span class="flex-1 font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                  {server.name}
                </span>
                <span class="text-[11px] text-muted-foreground shrink-0">
                  Gateway
                </span>
              </div>
            )}
          </For>

          {/* Local MCP servers */}
          <For each={connectionList()}>
            {(conn) => (
              <div
                class={`flex items-center gap-2 py-2 px-3 text-xs border-b border-border last:border-b-0 ${conn.status === "error" ? "bg-destructive/10" : ""}`}
              >
                <span class="text-[10px] shrink-0">
                  {conn.status === "connected"
                    ? "🟢"
                    : conn.status === "connecting"
                      ? "🟡"
                      : conn.status === "error"
                        ? "🔴"
                        : "⚪"}
                </span>
                <span class="flex-1 font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                  {conn.serverName}
                </span>
                <span class="text-[11px] text-muted-foreground shrink-0">
                  {conn.tools.length} tools
                </span>
                <Show when={conn.error}>
                  <span
                    class="text-[11px] text-destructive overflow-hidden text-ellipsis whitespace-nowrap max-w-[150px]"
                    title={conn.error}
                  >
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
