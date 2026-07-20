// ABOUTME: Shared MCP configuration builder for direct provider runtimes.
// ABOUTME: Normalizes Seren's MCP settings into provider-specific Claude/Codex formats.

import path from "node:path";

const SEREN_MCP_SERVER_NAME = "seren-mcp";
const SEREN_MCP_API_KEY_ENV = "SEREN_API_KEY";
const SEREN_MCP_GATEWAY_URL =
  process.env.SEREN_MCP_GATEWAY_URL ?? "https://mcp.serendb.com/mcp";

// serenorg/seren-desktop#1883 — Claude / Codex CLIs are compiled binaries that
// spawn stdio MCP children via libc execvp() against their own minimal PATH.
// A bare "node" command fails silently in that resolution, so the playwright
// MCP (and any other embedded node-based stdio server) never starts. The Rust
// provider-runtime supervisor injects SEREN_EMBEDDED_NODE_BIN with the
// absolute path to the embedded node binary it already spawned the runtime
// with; we rewrite "node" to that absolute path before emitting the CLI
// configs so the child CLI can exec it without a PATH lookup. Absolute paths
// and other bare commands (npx, python, ...) pass through unchanged.
function resolveLocalServerCommand(command) {
  if (typeof command !== "string" || command.length === 0) {
    return command;
  }
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return command;
  }
  if (command === "node") {
    const embeddedNode = process.env.SEREN_EMBEDDED_NODE_BIN;
    if (typeof embeddedNode === "string" && embeddedNode.length > 0) {
      return embeddedNode;
    }
  }
  return command;
}

function trimToNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLocalServer(server) {
  if (!server || server.enabled === false || server.type !== "local") {
    return null;
  }

  const name = trimToNull(server.name);
  const command = trimToNull(server.command);
  if (!name || !command) {
    return null;
  }

  const args = Array.isArray(server.args)
    ? server.args.filter((arg) => typeof arg === "string")
    : [];
  const envEntries = Object.entries(server.env ?? {}).filter(
    ([key, value]) => typeof key === "string" && typeof value === "string",
  );

  return {
    name,
    type: "stdio",
    command,
    args,
    env: Object.fromEntries(envEntries),
  };
}

function createRemoteSerenServer(apiKey, gatewayUrl = SEREN_MCP_GATEWAY_URL) {
  if (!trimToNull(apiKey)) {
    return null;
  }

  return {
    name: SEREN_MCP_SERVER_NAME,
    type: "http",
    url: gatewayUrl,
    headers: {
      Authorization: `Bearer \${${SEREN_MCP_API_KEY_ENV}}`,
    },
    bearerTokenEnvVar: SEREN_MCP_API_KEY_ENV,
  };
}

function dedupeServers(servers) {
  const deduped = new Map();
  for (const server of servers) {
    if (!server?.name) {
      continue;
    }
    deduped.set(server.name, server);
  }
  return Array.from(deduped.values());
}

function encodeTomlString(value) {
  const raw = String(value);
  if (!raw.includes("'") && !/[\r\n]/.test(raw)) {
    return `'${raw}'`;
  }
  if (!raw.includes("'''") && !/[\r\n]/.test(raw)) {
    return `'''${raw}'''`;
  }
  return JSON.stringify(raw);
}

function encodeTomlKey(key) {
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }
  return encodeTomlString(key);
}

function encodeTomlValue(value) {
  if (typeof value === "string") {
    return encodeTomlString(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : encodeTomlString(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeTomlValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, child]) => `${encodeTomlKey(key)}=${encodeTomlValue(child)}`)
      .join(",")}}`;
  }
  return "''";
}

function buildClaudeMcpConfig(servers) {
  if (servers.length === 0) {
    return null;
  }

  const mcpServers = {};
  for (const server of servers) {
    if (server.type === "http") {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        headers: server.headers ?? {},
      };
      continue;
    }

    mcpServers[server.name] = {
      type: "stdio",
      command: resolveLocalServerCommand(server.command),
      args: server.args ?? [],
      env: server.env ?? {},
    };
  }

  return JSON.stringify({ mcpServers });
}

function buildCodexMcpOverride(servers) {
  if (servers.length === 0) {
    return null;
  }

  const mcpServers = {};
  for (const server of servers) {
    if (server.type === "http") {
      mcpServers[server.name] = {
        url: server.url,
        bearer_token_env_var: server.bearerTokenEnvVar,
      };
      continue;
    }

    mcpServers[server.name] = {
      command: resolveLocalServerCommand(server.command),
      args: server.args ?? [],
      ...(server.env && Object.keys(server.env).length > 0
        ? { env: server.env }
        : {}),
    };
  }

  return `mcp_servers=${encodeTomlValue(mcpServers)}`;
}

// ACP agents consume MCP via the `session/new` JSON-RPC `mcpServers`
// parameter, a discriminated union on `type` with `headers`/`env` encoded as
// `[{name, value}]` arrays. The live initialize capabilities gate optional
// HTTP/SSE entries; stdio is part of the baseline protocol. #1887, #3084.
function encodeAcpPairs(record) {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}

function buildAcpMcpServers(servers, { mcpCapabilities = {} } = {}) {
  if (servers.length === 0) return [];
  const supportsHttp = mcpCapabilities.http === true;
  const supportsSse = mcpCapabilities.sse === true;

  const out = [];
  for (const server of servers) {
    if (server.type === "http") {
      if (!supportsHttp) continue;
      out.push({
        type: "http",
        name: server.name,
        url: server.url,
        headers: encodeAcpPairs(server.headers),
      });
      continue;
    }
    if (server.type === "sse") {
      if (!supportsSse) continue;
      out.push({
        type: "sse",
        name: server.name,
        url: server.url,
        headers: encodeAcpPairs(server.headers),
      });
      continue;
    }
    out.push({
      type: "stdio",
      name: server.name,
      command: resolveLocalServerCommand(server.command),
      args: server.args ?? [],
      env: encodeAcpPairs(server.env),
    });
  }
  return out;
}

export function buildProviderMcpConfig({
  apiKey,
  mcpServers,
  serenMcpGatewayUrl,
} = {}) {
  const normalizedServers = dedupeServers([
    createRemoteSerenServer(apiKey, serenMcpGatewayUrl),
    ...((Array.isArray(mcpServers) ? mcpServers : [])
      .map((server) => normalizeLocalServer(server))
      .filter(Boolean)),
  ].filter(Boolean));

  return {
    childEnv:
      trimToNull(apiKey) == null
        ? {}
        : { [SEREN_MCP_API_KEY_ENV]: trimToNull(apiKey) },
    claudeMcpConfigJson: buildClaudeMcpConfig(normalizedServers),
    codexMcpConfigOverride: buildCodexMcpOverride(normalizedServers),
    acpMcpServers: (mcpCapabilities) =>
      buildAcpMcpServers(normalizedServers, { mcpCapabilities }),
    // Compatibility alias for existing callers and focused #1887 coverage.
    geminiMcpServers: (mcpCapabilities) =>
      buildAcpMcpServers(normalizedServers, { mcpCapabilities }),
  };
}
