// ABOUTME: Service wrapper for the native build/version info Tauri command.
// ABOUTME: Lets UI surface the app version without calling invoke directly.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-bridge";

export interface BuildInfo {
  app_version: string;
  release_tag: string;
  commit: string;
  build_date: string;
  build_type: string;
  tauri_version: string;
  webview: string;
  rust_version: string;
  os: string;
}

/**
 * Read the native build info (version, release tag, commit, …). Returns null in
 * the browser fallback runtime, where the `get_build_info` Tauri command does
 * not exist. See #2497 — exposes the version in Settings → General so users can
 * report which build they are on.
 */
export async function getBuildInfo(): Promise<BuildInfo | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<BuildInfo>("get_build_info");
  } catch (error) {
    console.warn("[BuildInfo] Failed to read build info:", error);
    return null;
  }
}
