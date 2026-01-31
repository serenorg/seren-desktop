/* @refresh reload */
import { render } from "solid-js/web";
import { attachConsole } from "@tauri-apps/plugin-log";
import App from "./App";

// Bridge browser console output to the Rust log backend.
// In production, this persists console.log/error/warn to log files.
attachConsole();

render(() => <App />, document.getElementById("root") as HTMLElement);
