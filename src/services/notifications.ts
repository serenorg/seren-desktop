// ABOUTME: Native OS desktop notifications via the Tauri notification plugin, so
// ABOUTME: stores can post privacy-safe banners without touching the plugin API directly.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * Resolve to true only when the OS grants this app permission to post
 * notifications, requesting it once if the user has not yet decided. The
 * WebView `Notification` API is denied by default in this app's macOS webview,
 * so all OS banners must route through the native plugin.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  const permission = await requestPermission();
  return permission === "granted";
}

/**
 * Post one OS notification when permission allows. Silently no-ops when
 * permission is absent or the plugin is unavailable, so callers never branch on
 * platform support.
 */
export async function postNotification(
  title: string,
  body: string,
): Promise<void> {
  try {
    if (!(await ensureNotificationPermission())) return;
    sendNotification({ title, body });
  } catch (err) {
    console.warn("[Notifications] Failed to post notification:", err);
  }
}
