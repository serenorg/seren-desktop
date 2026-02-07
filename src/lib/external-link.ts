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
    // In Tauri, never fall back to window.open — it navigates the webview
    // and traps the user with no way to return to the app.
    console.warn("Tauri opener unavailable, cannot open:", url);
    return;
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Installs a global safety net that intercepts any anchor click navigating
 * to an external URL and routes it through openExternalLink instead.
 * Call once at app startup.
 */
export function installExternalLinkInterceptor(): void {
  document.addEventListener("click", (e) => {
    // Skip if another handler already processed this click (e.g., AgentChat, ChatPanel)
    if (e.defaultPrevented) return;

    const anchor = (e.target as HTMLElement).closest("a[href]");
    if (!anchor) return;
    const href = (anchor as HTMLAnchorElement).href;
    if (href && /^https?:\/\//i.test(href)) {
      e.preventDefault();
      openExternalLink(href);
    }
  });
}
