#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";
import { createProviderHandlers } from "./browser-local/providers.mjs";
import { addClient, emit, removeClient } from "./browser-local/events.mjs";
import { handleRpcMessage, registerHandler } from "./browser-local/rpc.mjs";

function usage() {
  console.log(`
Usage: seren-provider-runtime [--host <address>] [--port <number>] [--token <value>]

Starts the local provider runtime used by desktop-native and browser-local flows.

Options:
  --host <address>   Bind address. Default: 127.0.0.1
  --port <number>    HTTP port. Default: 0 (choose any free port)
  --token <value>    Required WebSocket auth token. Default: random
  --help, -h         Show this help message
`);
}

function parseArgs(argv) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    token: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      config.host = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`Invalid --port value: ${argv[i + 1] ?? ""}`);
      }
      config.port = value;
      i += 1;
      continue;
    }
    if (arg === "--token") {
      config.token = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!config.token) {
    config.token = randomBytes(24).toString("hex");
  }

  return config;
}

function registerProviderHandlers() {
  const providerHandlers = createProviderHandlers({ emit });

  registerHandler("provider_spawn", providerHandlers.spawnSession);
  registerHandler("provider_prompt", providerHandlers.sendPrompt);
  registerHandler("provider_cancel", providerHandlers.cancelPrompt);
  registerHandler("provider_terminate", providerHandlers.terminateSession);
  registerHandler("provider_list_sessions", providerHandlers.listSessions);
  registerHandler(
    "provider_set_permission_mode",
    providerHandlers.setPermissionMode,
  );
  registerHandler(
    "provider_respond_to_permission",
    providerHandlers.respondToPermission,
  );
  registerHandler(
    "provider_respond_to_diff_proposal",
    providerHandlers.respondToDiffProposal,
  );
  registerHandler(
    "provider_get_available_agents",
    providerHandlers.getAvailableAgents,
  );
  registerHandler(
    "provider_check_agent_available",
    providerHandlers.checkAgentAvailable,
  );
  registerHandler("provider_ensure_agent_cli", providerHandlers.ensureAgentCli);
  registerHandler("provider_launch_login", providerHandlers.launchLogin);
  registerHandler("provider_load_session", providerHandlers.loadSession);
  registerHandler("provider_fork_session", providerHandlers.forkSession);
  registerHandler(
    "provider_set_session_model",
    providerHandlers.setSessionModel,
  );
  registerHandler(
    "provider_set_session_mode",
    providerHandlers.setSessionMode,
  );
  registerHandler(
    "provider_update_session_config_option",
    providerHandlers.updateSessionConfigOption,
  );
  registerHandler(
    "provider_list_remote_sessions",
    providerHandlers.listRemoteSessions,
  );
}

function startServer(config) {
  registerProviderHandlers();

  const server = http.createServer((req, res) => {
    if (req.url === "/__seren/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: "desktop-native" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      let authenticated = false;

      ws.on("message", async (raw) => {
        const message = String(raw);

        if (!authenticated) {
          try {
            const parsed = JSON.parse(message);
            if (
              parsed?.method === "auth" &&
              parsed?.params?.token === config.token
            ) {
              authenticated = true;
              addClient(ws);
              ws.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id ?? null,
                  result: { ok: true },
                }),
              );
              return;
            }
          } catch {
            // fall through to auth error response
          }

          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: 401, message: "Unauthorized" },
              id: null,
            }),
          );
          ws.close();
          return;
        }

        const response = await handleRpcMessage(message);
        if (response) {
          ws.send(response);
        }
      });

      ws.on("close", () => {
        removeClient(ws);
      });
    });
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    console.log(
      JSON.stringify({
        ok: true,
        mode: "desktop-native",
        host: config.host,
        port,
        token: config.token,
      }),
    );
  });
}

try {
  startServer(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(
    `[provider-runtime] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
