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
    <div class="p-4 flex flex-col gap-4">
      <div class="flex justify-between items-center">
        <h3 class="m-0 text-lg font-semibold">MCP Servers</h3>
        <button
          class="px-4 py-2 bg-accent text-white border-none rounded-md cursor-pointer text-sm hover:bg-primary/85"
          onClick={() => setShowAddForm(!showAddForm())}
        >
          {showAddForm() ? "Cancel" : "Add Server"}
        </button>
      </div>

      <Show when={error()}>
        <div class="p-3 bg-destructive/10 text-destructive/85 rounded-md text-sm">
          {error()}
        </div>
      </Show>

      <Show when={showAddForm()}>
        <div class="p-4 bg-popover rounded-lg flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <label
              for="server-name"
              class="text-[13px] font-medium text-muted-foreground"
            >
              Server Name
            </label>
            <input
              id="server-name"
              type="text"
              placeholder="e.g., filesystem"
              value={newServerName()}
              onInput={(e) => setNewServerName(e.currentTarget.value)}
              class="px-3 py-2 border border-border-strong rounded-md text-sm bg-card text-foreground focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
            />
          </div>

          <div class="flex flex-col gap-1">
            <label
              for="server-command"
              class="text-[13px] font-medium text-muted-foreground"
            >
              Command
            </label>
            <input
              id="server-command"
              type="text"
              placeholder="e.g., npx"
              value={newServerCommand()}
              onInput={(e) => setNewServerCommand(e.currentTarget.value)}
              class="px-3 py-2 border border-border-strong rounded-md text-sm bg-card text-foreground focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
            />
          </div>

          <div class="flex flex-col gap-1">
            <label
              for="server-args"
              class="text-[13px] font-medium text-muted-foreground"
            >
              Arguments (comma-separated)
            </label>
            <input
              id="server-args"
              type="text"
              placeholder="e.g., -y, @modelcontextprotocol/server-filesystem, /path"
              value={newServerArgs()}
              onInput={(e) => setNewServerArgs(e.currentTarget.value)}
              class="px-3 py-2 border border-border-strong rounded-md text-sm bg-card text-foreground focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
            />
          </div>

          <div class="flex flex-row items-center gap-2">
            <input
              id="server-autoconnect"
              type="checkbox"
              checked={newServerAutoConnect()}
              onChange={(e) => setNewServerAutoConnect(e.currentTarget.checked)}
              class="w-4 h-4"
            />
            <label
              for="server-autoconnect"
              class="text-[13px] font-medium text-muted-foreground"
            >
              Auto-connect on startup
            </label>
          </div>

          <div class="flex gap-2 mt-2">
            <button
              class="px-4 py-2 bg-accent text-white border-none rounded-md cursor-pointer text-sm hover:bg-primary/85"
              onClick={handleAddServer}
            >
              Add Server
            </button>
            <button
              class="px-4 py-2 bg-popover text-foreground border border-border-strong rounded-md cursor-pointer text-sm hover:bg-border-medium"
              onClick={resetForm}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      <div class="flex flex-col gap-2">
        <Show
          when={mcpSettings().servers.length > 0}
          fallback={
            <div class="py-8 text-center text-muted-foreground text-sm">
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
                  class={`px-4 py-3 bg-popover border rounded-lg flex justify-between items-center gap-4 ${
                    !server.enabled
                      ? "opacity-60"
                      : status() === "connected"
                        ? "border-success"
                        : status() === "error"
                          ? "border-destructive/85"
                          : "border-border-strong"
                  } ${isBuiltin() ? "bg-primary/10 border-accent" : ""}`}
                >
                  <div class="flex-1 flex flex-col gap-1">
                    <div class="flex items-center gap-2">
                      <span class="font-semibold text-sm">{server.name}</span>
                      <Show when={isBuiltin()}>
                        <span class="px-2 py-0.5 rounded-xl text-[10px] font-semibold uppercase bg-accent text-white">
                          Built-in
                        </span>
                      </Show>
                      <span
                        class={`px-2 py-0.5 rounded-xl text-[11px] font-medium uppercase ${
                          status() === "disconnected"
                            ? "bg-popover text-muted-foreground"
                            : status() === "connecting"
                              ? "bg-warning/15 text-warning/70"
                              : status() === "connected"
                                ? "bg-success/15 text-success/85"
                                : "bg-destructive/10 text-destructive/85"
                        }`}
                      >
                        {isBuiltin() && status() === "connected"
                          ? "Connected (Gateway)"
                          : status()}
                      </span>
                    </div>
                    <Show
                      when={isLocal()}
                      fallback={
                        <div class="text-xs text-muted-foreground italic">
                          {isBuiltinServer(server) && server.description}
                        </div>
                      }
                    >
                      <Show
                        when={server.name !== "Seren MCP"}
                        fallback={
                          <div class="text-xs text-muted-foreground italic">
                            Connected to Seren MCP Gateway
                          </div>
                        }
                      >
                        <div class="text-xs text-muted-foreground font-mono">
                          {isLocalServer(server) &&
                            `${server.command} ${server.args.join(" ")}`}
                        </div>
                      </Show>
                    </Show>
                    <Show
                      when={server.autoConnect && server.name !== "Seren MCP"}
                    >
                      <span class="text-[11px] text-accent">Auto-connect</span>
                    </Show>
                  </div>

                  <div class="flex gap-2">
                    <Show when={isLocal()}>
                      <Show
                        when={status() === "connected"}
                        fallback={
                          <button
                            class="px-3 py-1.5 rounded text-xs cursor-pointer bg-success text-white border-none hover:not-disabled:bg-success/85 disabled:opacity-50 disabled:cursor-not-allowed"
                            onClick={() => handleConnect(server)}
                            disabled={!server.enabled || isConnecting()}
                          >
                            {isConnecting() ? "Connecting..." : "Connect"}
                          </button>
                        }
                      >
                        <button
                          class="px-3 py-1.5 rounded text-xs cursor-pointer bg-warning/85 text-white border-none hover:bg-warning/70"
                          onClick={() => handleDisconnect(server.name)}
                        >
                          Disconnect
                        </button>
                      </Show>

                      <button
                        class="px-3 py-1.5 rounded text-xs cursor-pointer bg-popover text-foreground border border-border-strong hover:bg-border-medium"
                        onClick={() => handleToggle(server.name)}
                      >
                        {server.enabled ? "Disable" : "Enable"}
                      </button>

                      <button
                        class="px-3 py-1.5 rounded text-xs cursor-pointer bg-destructive text-white border-none hover:bg-destructive/85"
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
