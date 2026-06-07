// ABOUTME: Service wrapper for the system tray's live meeting-capture indicator.
// ABOUTME: Flips the tray tooltip and relays the tray's capture-toggle requests.

import { isTauriRuntime } from "@/lib/tauri-bridge";

const TRAY_TOGGLE_CAPTURE_EVENT = "tray://toggle-capture";

/**
 * Reflect the live capture state on the system tray. No-op outside Tauri.
 */
export async function setTrayRecording(recording: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_tray_recording", { recording });
}

/**
 * Subscribe to the tray menu's Start/Stop capture action. Returns an unlisten
 * function. No-op (no-op cleanup) outside Tauri.
 */
export async function onTrayToggleCapture(
  handler: () => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen(TRAY_TOGGLE_CAPTURE_EVENT, () => handler());
  return unlisten;
}
