// ABOUTME: MCP auto-connect service for startup connection.
// ABOUTME: Connects to local servers marked with autoConnect when app loads.

import {
  getAutoConnectMcpServers,
  loadMcpSettings,
  mcpSettings,
} from "@/stores/settings.store";
import { mcpClient } from "./client";
import { isLocalServer } from "./types";

export interface AutoConnectResult {
  serverName: string;
  success: boolean;
  error?: string;
}

/**
 * Initialize MCP auto-connect on application startup.
 * Loads settings and connects to all servers marked for auto-connect.
 */
export async function initMcpAutoConnect(): Promise<AutoConnectResult[]> {
  // First, load MCP settings from storage
  await loadMcpSettings();

  // Get servers configured for auto-connect
  const autoConnectServers = getAutoConnectMcpServers();

  if (autoConnectServers.length === 0) {
    return [];
  }

  // Filter to only local servers (builtin servers connect via gateway)
  const localServers = autoConnectServers.filter(isLocalServer);

  if (localServers.length === 0) {
    return [];
  }

  // Connect to each local server in parallel
  const results = await Promise.allSettled(
    localServers.map(async (server) => {
      try {
        await mcpClient.connect(
          server.name,
          server.command,
          server.args,
          server.env,
        );
        return {
          serverName: server.name,
          success: true,
        };
      } catch (error) {
        return {
          serverName: server.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  // Extract results
  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      serverName: localServers[index].name,
      success: false,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    };
  });
}

/**
 * Retry failed auto-connect servers.
 * Only retries local servers (builtin servers connect via gateway).
 */
export async function retryFailedConnections(
  failedServers: string[],
): Promise<AutoConnectResult[]> {
  const servers = mcpSettings()
    .servers.filter((s) => failedServers.includes(s.name) && s.enabled)
    .filter(isLocalServer);

  if (servers.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    servers.map(async (server) => {
      try {
        await mcpClient.connect(
          server.name,
          server.command,
          server.args,
          server.env,
        );
        return {
          serverName: server.name,
          success: true,
        };
      } catch (error) {
        return {
          serverName: server.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      serverName: servers[index].name,
      success: false,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    };
  });
}

/**
 * Connect all enabled local servers (not just auto-connect).
 * Useful for manual "connect all" action.
 * Only connects local servers (builtin servers connect via gateway).
 */
export async function connectAllEnabledServers(): Promise<AutoConnectResult[]> {
  const servers = mcpSettings()
    .servers.filter((s) => s.enabled)
    .filter(isLocalServer);

  // Skip already connected servers
  const toConnect = servers.filter((s) => {
    const conn = mcpClient.getConnection(s.name);
    return !conn || conn.status !== "connected";
  });

  if (toConnect.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    toConnect.map(async (server) => {
      try {
        await mcpClient.connect(
          server.name,
          server.command,
          server.args,
          server.env,
        );
        return {
          serverName: server.name,
          success: true,
        };
      } catch (error) {
        return {
          serverName: server.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      serverName: toConnect[index].name,
      success: false,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    };
  });
}

/**
 * Disconnect all connected servers.
 * Useful for cleanup on app shutdown.
 */
export async function disconnectAllServers(): Promise<void> {
  const connections = Array.from(mcpClient.connections().values());
  const connected = connections.filter((c) => c.status === "connected");

  await Promise.allSettled(
    connected.map((conn) => mcpClient.disconnect(conn.serverName)),
  );
}
