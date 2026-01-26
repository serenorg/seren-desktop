// ABOUTME: UI panel for managing MCP server configurations.
// ABOUTME: Allows adding, removing, enabling/disabling MCP servers.

import { type Component, createSignal, For, Show } from "solid-js";
import { mcpClient } from "@/lib/mcp/client";
import type { McpLocalServerConfig, McpServerConfig } from "@/lib/mcp/types";
import { isBuiltinServer, isLocalServer } from "@/lib/mcp/types";
import { authStore } from "@/stores/auth.store";
import {
  addMcpServer,
  mcpSettings,
  removeMcpServer,
  toggleMcpServer,
} from "@/stores/settings.store";
import "./McpServersPanel.css";

export const McpServersPanel: Component = () => {
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [newServerName, setNewServerName] = createSignal("");
  const [newServerCommand, setNewServerCommand] = createSignal("");
  const [newServerArgs, setNewServerArgs] = createSignal("");
  const [newServerAutoConnect, setNewServerAutoConnect] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [connecting, setConnecting] = createSignal<string | null>(null);

  async function handleAddServer(): Promise<void> {
    const name = newServerName().trim();
    const command = newServerCommand().trim();

    if (!name || !command) {
      setError("Server name and command are required");
      return;
    }

    // Check for duplicate name
    if (mcpSettings().servers.some((s) => s.name === name)) {
      setError("A server with this name already exists");
      return;
    }

    const args = newServerArgs()
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const server: McpLocalServerConfig = {
      type: "local",
      name,
      command,
      args,
      enabled: true,
      autoConnect: newServerAutoConnect(),
    };

    try {
      await addMcpServer(server);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add server");
    }
  }

  function resetForm(): void {
    setNewServerName("");
    setNewServerCommand("");
    setNewServerArgs("");
    setNewServerAutoConnect(false);
    setShowAddForm(false);
    setError(null);
  }

  async function handleToggle(name: string): Promise<void> {
    try {
      await toggleMcpServer(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle server");
    }
  }

  async function handleRemove(name: string): Promise<void> {
    if (!confirm(`Remove MCP server "${name}"?`)) return;

    try {
      // Disconnect if connected
      const conn = mcpClient.getConnection(name);
      if (conn && conn.status === "connected") {
        await mcpClient.disconnect(name);
      }
      await removeMcpServer(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove server");
    }
  }

  async function handleConnect(server: McpServerConfig): Promise<void> {
    // Only local servers can be manually connected
    if (!isLocalServer(server)) {
      return;
    }

    setConnecting(server.name);
    setError(null);

    try {
      await mcpClient.connect(
        server.name,
        server.command,
        server.args,
        server.env,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setConnecting(null);
    }
  }

  async function handleDisconnect(name: string): Promise<void> {
    try {
      await mcpClient.disconnect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    }
  }

  function getConnectionStatus(server: McpServerConfig): string {
    // Builtin servers are connected via gateway when user is authenticated
    if (isBuiltinServer(server)) {
      return authStore.isAuthenticated ? "connected" : "disconnected";
    }

    const conn = mcpClient.getConnection(server.name);
    return conn?.status || "disconnected";
  }

  return (
    <div class="mcp-servers-panel">
      <div class="panel-header">
        <h3>MCP Servers</h3>
        <button class="btn-add" onClick={() => setShowAddForm(!showAddForm())}>
          {showAddForm() ? "Cancel" : "Add Server"}
        </button>
      </div>

      <Show when={error()}>
        <div class="error-message">{error()}</div>
      </Show>

      <Show when={showAddForm()}>
        <div class="add-server-form">
          <div class="form-field">
            <label for="server-name">Server Name</label>
            <input
              id="server-name"
              type="text"
              placeholder="e.g., filesystem"
              value={newServerName()}
              onInput={(e) => setNewServerName(e.currentTarget.value)}
            />
          </div>

          <div class="form-field">
            <label for="server-command">Command</label>
            <input
              id="server-command"
              type="text"
              placeholder="e.g., npx"
              value={newServerCommand()}
              onInput={(e) => setNewServerCommand(e.currentTarget.value)}
            />
          </div>

          <div class="form-field">
            <label for="server-args">Arguments (comma-separated)</label>
            <input
              id="server-args"
              type="text"
              placeholder="e.g., -y, @modelcontextprotocol/server-filesystem, /path"
              value={newServerArgs()}
              onInput={(e) => setNewServerArgs(e.currentTarget.value)}
            />
          </div>

          <div class="form-field checkbox">
            <input
              id="server-autoconnect"
              type="checkbox"
              checked={newServerAutoConnect()}
              onChange={(e) => setNewServerAutoConnect(e.currentTarget.checked)}
            />
            <label for="server-autoconnect">Auto-connect on startup</label>
          </div>

          <div class="form-actions">
            <button class="btn-primary" onClick={handleAddServer}>
              Add Server
            </button>
            <button class="btn-secondary" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <div class="server-list">
        <Show
          when={mcpSettings().servers.length > 0}
          fallback={
            <div class="empty-state">
              No MCP servers configured. Click "Add Server" to get started.
            </div>
          }
        >
          <For each={mcpSettings().servers}>
            {(server) => {
              const status = () => getConnectionStatus(server);
              const isConnecting = () => connecting() === server.name;
              const isBuiltin = () => isBuiltinServer(server);
              const isLocal = () => isLocalServer(server);

              return (
                <div
                  class="server-item"
                  classList={{
                    disabled: !server.enabled,
                    connected: status() === "connected",
                    error: status() === "error",
                    builtin: isBuiltin(),
                  }}
                >
                  <div class="server-info">
                    <div class="server-name">
                      <span class="name">{server.name}</span>
                      <Show when={isBuiltin()}>
                        <span class="builtin-badge">Built-in</span>
                      </Show>
                      <span class={`status-badge ${status()}`}>
                        {isBuiltin() && status() === "connected"
                          ? "Connected (Gateway)"
                          : status()}
                      </span>
                    </div>
                    <Show
                      when={isLocal()}
                      fallback={
                        <div class="server-description">
                          {isBuiltinServer(server) && server.description}
                        </div>
                      }
                    >
                      <div class="server-command">
                        {isLocalServer(server) &&
                          `${server.command} ${server.args.join(" ")}`}
                      </div>
                    </Show>
                    <Show when={server.autoConnect && isLocal()}>
                      <span class="auto-connect-badge">Auto-connect</span>
                    </Show>
                  </div>

                  <div class="server-actions">
                    <Show when={isLocal()}>
                      <Show
                        when={status() === "connected"}
                        fallback={
                          <button
                            class="btn-connect"
                            onClick={() => handleConnect(server)}
                            disabled={!server.enabled || isConnecting()}
                          >
                            {isConnecting() ? "Connecting..." : "Connect"}
                          </button>
                        }
                      >
                        <button
                          class="btn-disconnect"
                          onClick={() => handleDisconnect(server.name)}
                        >
                          Disconnect
                        </button>
                      </Show>

                      <button
                        class="btn-toggle"
                        onClick={() => handleToggle(server.name)}
                      >
                        {server.enabled ? "Disable" : "Enable"}
                      </button>

                      <button
                        class="btn-remove"
                        onClick={() => handleRemove(server.name)}
                      >
                        Remove
                      </button>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default McpServersPanel;
