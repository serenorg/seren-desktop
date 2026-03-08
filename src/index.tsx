/* @refresh reload */
import { render } from "solid-js/web";
import { installExternalLinkInterceptor } from "@/lib/external-link";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import App from "./App";

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

render(() => <App />, document.getElementById("root") as HTMLElement);
