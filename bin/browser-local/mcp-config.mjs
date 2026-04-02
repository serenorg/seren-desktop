// ABOUTME: Shared MCP configuration builder for direct provider runtimes.
// ABOUTME: Normalizes Seren's MCP settings into provider-specific Claude/Codex formats.

const SEREN_MCP_SERVER_NAME = "seren-mcp";
const SEREN_MCP_API_KEY_ENV = "SEREN_API_KEY";
const SEREN_MCP_GATEWAY_URL =
  process.env.SEREN_MCP_GATEWAY_URL ?? "https://mcp.serendb.com/mcp";

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

function createRemoteSerenServer(apiKey) {
  if (!trimToNull(apiKey)) {
    return null;
  }

  return {
    name: SEREN_MCP_SERVER_NAME,
    type: "http",
    url: SEREN_MCP_GATEWAY_URL,
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

function encodeTomlValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeTomlValue(item)).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)}=${encodeTomlValue(child)}`)
      .join(", ")}}`;
  }
  return '""';
}

function buildClaudeMcpConfig(servers, childEnv) {
  if (servers.length === 0) {
    return null;
  }

  const mcpServers = {};
  for (const server of servers) {
    if (server.type === "http") {
      // Resolve env var placeholders in headers to actual values.
      // Claude CLI may not expand ${VAR} in MCP config headers on all
      // platforms. Use the real value from childEnv to guarantee it works.
      const resolvedHeaders = {};
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        resolvedHeaders[key] =
          typeof value === "string"
            ? value.replace(/\$\{(\w+)\}/g, (_, varName) => childEnv[varName] ?? process.env[varName] ?? "")
            : value;
      }
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        headers: resolvedHeaders,
      };
      continue;
    }

    mcpServers[server.name] = {
      type: "stdio",
      command: server.command,
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
      command: server.command,
      args: server.args ?? [],
      ...(server.env && Object.keys(server.env).length > 0
        ? { env: server.env }
        : {}),
    };
  }

  return `mcp_servers=${encodeTomlValue(mcpServers)}`;
}

export function buildProviderMcpConfig({ apiKey, mcpServers } = {}) {
  const normalizedServers = dedupeServers([
    createRemoteSerenServer(apiKey),
    ...((Array.isArray(mcpServers) ? mcpServers : [])
      .map((server) => normalizeLocalServer(server))
      .filter(Boolean)),
  ].filter(Boolean));

  const childEnv =
    trimToNull(apiKey) == null
      ? {}
      : { [SEREN_MCP_API_KEY_ENV]: trimToNull(apiKey) };

  return {
    childEnv,
    claudeMcpConfigJson: buildClaudeMcpConfig(normalizedServers, childEnv),
    codexMcpConfigOverride: buildCodexMcpOverride(normalizedServers),
  };
}
