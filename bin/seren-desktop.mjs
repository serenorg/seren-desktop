#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = join(rootDir, "dist");
const indexHtmlPath = join(distDir, "index.html");

function usage() {
  console.log(`
Usage: seren-desktop [--host <address>] [--port <number>] [--no-browser]

Starts Seren Desktop in browser-local mode using a lightweight local HTTP server.

Options:
  --host <address>  Bind address. Default: 127.0.0.1
  --port <number>   HTTP port. Default: 4310
  --no-browser      Do not open the browser automatically
  --help, -h        Show this help message
`);
}

function parseArgs(argv) {
  const config = {
    host: "127.0.0.1",
    port: 4310,
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

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit ${result.status}`);
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

function injectRuntimeConfig(html, origin) {
  const wsOrigin = origin.replace(/^http/i, "ws");
  const runtimeConfig = {
    mode: "browser-local",
    capabilities: {
      acp: false,
      localFiles: false,
      localMcp: false,
      openclaw: false,
      terminal: false,
      updater: false,
      remoteSerenAgent: true,
    },
    apiBaseUrl: origin,
    wsBaseUrl: wsOrigin,
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
    spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", shell: false });
    return;
  }
  spawnSync("xdg-open", [url], { stdio: "ignore" });
}

function main() {
  ensureBuiltAssets();
  const { host, port, openBrowser: shouldOpenBrowser } = parseArgs(process.argv.slice(2));
  const rawIndexHtml = readFileSync(indexHtmlPath, "utf8");
  const origin = `http://${host}:${port}`;
  const indexHtml = injectRuntimeConfig(rawIndexHtml, origin);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);

    if (url.pathname === "/__seren/health") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(JSON.stringify({ ok: true, mode: "browser-local" }));
      return;
    }

    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/vite.svg") || url.pathname.startsWith("/tauri.svg")) {
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

  server.listen(port, host, () => {
    console.log(`[seren-desktop] Browser-local server running at ${origin}`);
    console.log("[seren-desktop] ACP bridge is not wired yet; browser-local currently runs in remote-agent-only mode.");
    if (shouldOpenBrowser) {
      openBrowser(origin);
    }
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  usage();
  process.exit(1);
}
