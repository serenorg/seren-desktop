import type { open as OpenFn } from "@tauri-apps/plugin-opener";
import { isTauriRuntime } from "@/lib/tauri-bridge";

let opener: typeof OpenFn | null = null;

async function getOpener(): Promise<typeof OpenFn | null> {
  if (!isTauriRuntime()) return null;
  if (opener) return opener;
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    opener = mod.open;
    return opener;
  } catch {
    return null;
  }
}

export async function openExternalLink(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const openFn = await getOpener();
    if (openFn) {
      try {
        await openFn(url, { activate: true });
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
