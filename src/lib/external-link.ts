// ABOUTME: External link handler for opening URLs in the default browser.
// ABOUTME: Uses Tauri opener plugin when available, falls back to window.open.

import { isTauriRuntime } from "@/lib/tauri-bridge";

type OpenUrlFn = (url: string | URL, openWith?: string) => Promise<void>;

let openUrlFn: OpenUrlFn | null = null;

async function getOpenUrl(): Promise<OpenUrlFn | null> {
  if (!isTauriRuntime()) return null;
  if (openUrlFn) return openUrlFn;
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    openUrlFn = mod.openUrl;
    return openUrlFn;
  } catch {
    return null;
  }
}

export async function openExternalLink(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const openFn = await getOpenUrl();
    if (openFn) {
      try {
        await openFn(url);
        return;
      } catch (error) {
        console.error("Failed to open external link via Tauri", error);
      }
    }
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
