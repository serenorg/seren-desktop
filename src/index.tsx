/* @refresh reload */
// JetBrains Mono — register the four weight/style combinations the canvas
// terminal cells render with (regular, italic, bold, bold-italic). Without
// these, the `--font-mono` stack in styles.css falls through to SF Mono /
// Menlo and the themed Claude Code CLI terminal silently loses its
// signature typography (#2010).
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/700-italic.css";
import { QueryClientProvider } from "@tanstack/solid-query";
import { render } from "solid-js/web";
import { installExternalLinkInterceptor } from "@/lib/external-link";
import { queryClient } from "@/lib/query-client";
import { installSupportReporting } from "@/lib/support/hook";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { installValidationControlBridge } from "@/services/validation-control";
import { hydrateAppearanceSync } from "@/stores/appearance.store";
import App from "./App";

// Apply theme + appearance vars BEFORE mounting so the first paint matches
// the user's saved choice. The Tauri store (canonical) is read async in
// AppShell.onMount and reconciles if it disagrees with this hot cache.
hydrateAppearanceSync();

document.documentElement.dataset.buildCommit = __SEREN_BUILD_COMMIT__;
document.documentElement.dataset.buildTimestamp = __SEREN_BUILD_TIMESTAMP__;

const root = document.getElementById("root") as HTMLElement;

// Bridge browser console output to the Rust log backend.
// In production, this persists console.log/error/warn to log files.
if (isTauriRuntime()) {
  void import("@tauri-apps/plugin-log")
    .then((mod) => mod.attachConsole())
    .catch((error) =>
      console.warn("[Runtime] Failed to attach Tauri console bridge:", error),
    );
}

// Prevent external URLs from navigating the webview
installExternalLinkInterceptor();
installSupportReporting();
installValidationControlBridge();

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  ),
  root,
);
