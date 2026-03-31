import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type PluginOption } from "vite";
import solid from "vite-plugin-solid";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const BUILD_TIMESTAMP = new Date().toISOString();
const BUILD_COMMIT = resolveBuildCommit();

function resolveBuildCommit(): string {
  const envCommit =
    process.env.VITE_BUILD_COMMIT?.trim() || process.env.GITHUB_SHA?.trim();
  if (envCommit) {
    return envCommit;
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function buildMetadataPlugin(): PluginOption {
  const manifest = `${JSON.stringify(
    {
      commit: BUILD_COMMIT,
      builtAt: BUILD_TIMESTAMP,
    },
    null,
    2,
  )}\n`;

  return {
    name: "seren-build-metadata",
    apply: "build",
    transformIndexHtml() {
      return {
        tags: [
          {
            tag: "meta",
            attrs: {
              name: "seren-build-commit",
              content: BUILD_COMMIT,
            },
            injectTo: "head",
          },
          {
            tag: "meta",
            attrs: {
              name: "seren-build-timestamp",
              content: BUILD_TIMESTAMP,
            },
            injectTo: "head",
          },
        ],
      };
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-manifest.json",
        source: manifest,
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), solid(), buildMetadataPlugin()],
  define: {
    __SEREN_BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __SEREN_BUILD_TIMESTAMP__: JSON.stringify(BUILD_TIMESTAMP),
  },

  // Path aliases
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // Shim qrcode CJS → ESM for Thirdweb's dynamic import("qrcode")
      qrcode: resolve(__dirname, "src/lib/qrcode-shim.ts"),
    },
  },

  // Optimize Monaco Editor
  optimizeDeps: {
    include: ["monaco-editor", "qrcode"],
  },

  // Build configuration for Monaco workers.
  // Vite 8 uses Rolldown which only supports the function form of manualChunks.
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("monaco-editor")) {
            return "monaco-editor";
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/.agent-shell/**"],
    },
  },
}));
