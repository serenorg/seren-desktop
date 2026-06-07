// ABOUTME: Service wrapper for the floating always-on-top meeting capture widget window.
// ABOUTME: Owns the WebviewWindow lifecycle so components never touch Tauri window APIs.

import { isTauriRuntime } from "@/lib/tauri-bridge";

const WIDGET_LABEL = "capture-widget";
const WIDGET_STOP_EVENT = "meeting://widget-stop";

/**
 * Open the floating capture widget when a meeting capture starts. The widget
 * loads the same Vite bundle at `?widget=1`, which the app entry guard renders
 * as the compact CaptureWidget instead of the full app. No-op outside Tauri and
 * idempotent if the widget is already open.
 */
export async function openCaptureWidget(meetingId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

  const existing = await WebviewWindow.getByLabel(WIDGET_LABEL);
  if (existing) {
    try {
      await existing.show();
      await existing.setFocus();
    } catch {
      // Window may be mid-teardown; a fresh start will recreate it.
    }
    return;
  }

  const url = `index.html?widget=1&meeting=${encodeURIComponent(meetingId)}`;
  const widget = new WebviewWindow(WIDGET_LABEL, {
    url,
    title: "Meeting capture",
    width: 220,
    height: 80,
    resizable: false,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    shadow: true,
    focus: false,
    transparent: true,
  });

  await new Promise<void>((resolve, reject) => {
    void widget.once("tauri://created", () => resolve());
    void widget.once("tauri://error", (event) => {
      reject(new Error(String(event.payload)));
    });
  });
}

/**
 * Close the floating capture widget when capture stops. No-op outside Tauri or
 * when the widget is not open.
 */
export async function closeCaptureWidget(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const widget = await WebviewWindow.getByLabel(WIDGET_LABEL);
  if (!widget) return;
  try {
    await widget.close();
  } catch {
    // Already gone; nothing to do.
  }
}

/**
 * Emit a global request to stop the active meeting capture. Fired from the
 * widget window's Stop button; the main window owns the actual stop + notes
 * flow and handles this via {@link onWidgetStopRequest}.
 */
export async function requestCaptureStop(meetingId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(WIDGET_STOP_EVENT, meetingId);
}

/**
 * Subscribe (from the main window) to widget Stop requests. Returns an unlisten
 * function. No-op outside Tauri, returning a no-op cleanup.
 */
export async function onWidgetStopRequest(
  handler: (meetingId: string) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<string>(WIDGET_STOP_EVENT, (event) => {
    handler(event.payload);
  });
  return unlisten;
}
