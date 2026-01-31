/* @refresh reload */
import { attachConsole } from "@tauri-apps/plugin-log";
import { render } from "solid-js/web";
import { installExternalLinkInterceptor } from "@/lib/external-link";
import App from "./App";

// Bridge browser console output to the Rust log backend.
// In production, this persists console.log/error/warn to log files.
attachConsole();

// Prevent external URLs from navigating the webview
installExternalLinkInterceptor();

render(() => <App />, document.getElementById("root") as HTMLElement);
