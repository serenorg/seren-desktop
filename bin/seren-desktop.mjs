#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createProviderHandlers } from "./browser-local/providers.mjs";
import {
  openFileDialog,
  openFolderDialog,
  revealInFileManager,
  saveFileDialog,
} from "./browser-local/dialogs.mjs";
import { addClient, emit, removeClient } from "./browser-local/events.mjs";
import {
  createDirectory,
  createFile,
  deletePath,
  isDirectory,
  listDirectory,
  pathExists,
  readFile,
  readFileBase64,
  renamePath,
  writeFile,
} from "./browser-local/fs.mjs";
import { handleRpcMessage, registerHandler } from "./browser-local/rpc.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = join(rootDir, "dist");
const indexHtmlPath = join(distDir, "index.html");

function usage() {
  console.log(`
Usage: seren-desktop [--host <address>] [--port <number>] [--project <path>] [--no-browser]

Starts Seren Desktop in browser-local mode using a local HTTP + WebSocket runtime.

Options:
  --host <address>   Bind address. Default: 127.0.0.1
  --port <number>    HTTP port. Default: 4310
  --project <path>   Initial project root. Default: current working directory
  --no-browser       Do not open the browser automatically
  --help, -h         Show this help message
`);
}

function parseArgs(argv) {
  const config = {
    host: "127.0.0.1",
    port: 4310,
    projectRoot: process.cwd(),
    openBrowser: true,
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
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new Error(`Invalid --port value: ${argv[i + 1] ?? ""}`);
      }
      config.port = value;
      i += 1;
      continue;
    }
    if (arg === "--project") {
      config.projectRoot = resolve(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--no-browser") {
      config.openBrowser = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return config;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}`,
    );
  }
}

function ensureBuiltAssets() {
  if (existsSync(indexHtmlPath)) {
    return;
  }

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  console.log("[seren-desktop] dist/ missing, running `pnpm build`...");
  run(pnpm, ["build"], rootDir);
}

function contentTypeForPath(pathname) {
  switch (extname(pathname).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function injectRuntimeConfig(html, origin, projectRoot) {
  const runtimeConfig = {
    mode: "browser-local",
    capabilities: {
      agents: true,
      localFiles: true,
      localMcp: false,
      terminal: false,
      updater: false,
      remoteSerenAgent: true,
    },
    apiBaseUrl: origin,
    wsBaseUrl: origin.replace(/^http/i, "ws"),
    localProjectRoot: projectRoot,
  };

  const injection = `<script>window.__SEREN_RUNTIME_CONFIG__ = ${JSON.stringify(runtimeConfig)};</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${injection}</head>`);
  }
  return `${injection}${html}`;
}

function serveStaticFile(res, absolutePath) {
  const stat = statSync(absolutePath);
  res.writeHead(200, {
    "Content-Length": stat.size,
    "Content-Type": contentTypeForPath(absolutePath),
    "Cache-Control": "no-cache",
  });
  createReadStream(absolutePath).pipe(res);
}

function safeResolveAsset(urlPath) {
  const pathname = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, "");
  const absolutePath = resolve(distDir, pathname);
  if (!absolutePath.startsWith(distDir)) {
    return null;
  }
  return absolutePath;
}

function openBrowser(url) {
  if (process.platform === "darwin") {
    spawnSync("open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "win32") {
    spawnSync("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      shell: false,
    });
    return;
  }
  spawnSync("xdg-open", [url], { stdio: "ignore" });
}

function isLoopbackAddress(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function registerBrowserLocalHandlers() {
  registerHandler("list_directory", listDirectory);
  registerHandler("read_file", readFile);
  registerHandler("read_file_base64", readFileBase64);
  registerHandler("write_file", writeFile);
  registerHandler("path_exists", pathExists);
  registerHandler("is_directory", isDirectory);
  registerHandler("create_file", createFile);
  registerHandler("create_directory", createDirectory);
  registerHandler("delete_path", deletePath);
  registerHandler("rename_path", renamePath);
  registerHandler("open_folder_dialog", openFolderDialog);
  registerHandler("open_file_dialog", openFileDialog);
  registerHandler("save_file_dialog", saveFileDialog);
  registerHandler("reveal_in_file_manager", revealInFileManager);

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
  registerHandler(
    "provider_ensure_agent_cli",
    providerHandlers.ensureAgentCli,
  );
  registerHandler("provider_launch_login", providerHandlers.launchLogin);
  registerHandler(
    "provider_list_remote_sessions",
    providerHandlers.listRemoteSessions,
  );
  registerHandler(
    "provider_native_fork_session",
    providerHandlers.nativeForkSession,
  );
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
}

function main() {
  ensureBuiltAssets();
  registerBrowserLocalHandlers();

  const {
    host,
    port,
    projectRoot,
    openBrowser: shouldOpenBrowser,
  } = parseArgs(process.argv.slice(2));

  const rawIndexHtml = readFileSync(indexHtmlPath, "utf8");
  const origin = `http://${host}:${port}`;
  const authToken = randomBytes(32).toString("hex");
  const indexHtml = injectRuntimeConfig(rawIndexHtml, origin, projectRoot);

  const server = http.createServer((req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const url = new URL(req.url ?? "/", origin);

    if (url.pathname === "/__seren/health") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(
        JSON.stringify({
          ok: true,
          mode: "browser-local",
          token: authToken,
          projectRoot,
        }),
      );
      return;
    }

    if (
      url.pathname.startsWith("/assets/") ||
      url.pathname.startsWith("/vite.svg") ||
      url.pathname.startsWith("/tauri.svg")
    ) {
      const assetPath = safeResolveAsset(url.pathname);
      if (!assetPath || !existsSync(assetPath) || !statSync(assetPath).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      serveStaticFile(res, assetPath);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(indexHtml);
  });

  const authenticatedSockets = new WeakSet();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws, req) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      ws.close(4003, "Forbidden");
      return;
    }

    const originHeader = req.headers.origin;
    if (originHeader && originHeader !== origin) {
      ws.close(4003, "Forbidden origin");
      return;
    }

    const authTimeout = setTimeout(() => {
      if (!authenticatedSockets.has(ws)) {
        ws.close(4001, "Authentication timeout");
      }
    }, 5_000);

    ws.on("message", async (data) => {
      const raw = String(data);

      if (!authenticatedSockets.has(ws)) {
        try {
          const authMessage = JSON.parse(raw);
          if (
            authMessage.method === "auth" &&
            authMessage.params?.token === authToken
          ) {
            authenticatedSockets.add(ws);
            addClient(ws);
            clearTimeout(authTimeout);
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                result: { authenticated: true },
                id: authMessage.id ?? null,
              }),
            );
            return;
          }
        } catch {
          // fall through to close
        }

        ws.close(4002, "Invalid auth token");
        return;
      }

      const response = await handleRpcMessage(raw);
      if (response) {
        ws.send(response);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      removeClient(ws);
    });
  });

  server.listen(port, host, () => {
    console.log(`[seren-desktop] Browser-local server running at ${origin}`);
    console.log(`[seren-desktop] Project root: ${projectRoot}`);
    if (shouldOpenBrowser) {
      openBrowser(origin);
    }
  });

  const shutdown = () => {
    wss.close(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
