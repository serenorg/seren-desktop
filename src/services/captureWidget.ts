// ABOUTME: Service wrapper for the floating always-on-top meeting capture widget window.
// ABOUTME: Owns the WebviewWindow lifecycle so components never touch Tauri window APIs.

import { isTauriRuntime } from "@/lib/tauri-bridge";

const WIDGET_LABEL = "capture-widget";
const WIDGET_STOP_EVENT = "meeting://widget-stop";
const WIDGET_WIDTH = 220;
const WIDGET_HEIGHT = 80;
const WIDGET_MARGIN = 16;
const TITLEBAR_CLEARANCE = 48;

interface WidgetPosition {
  x: number;
  y: number;
}

export async function captureWidgetPosition(): Promise<WidgetPosition> {
  const { currentMonitor, getCurrentWindow, primaryMonitor } = await import(
    "@tauri-apps/api/window"
  );

  try {
    const appWindow = getCurrentWindow();
    const [position, size, scaleFactor] = await Promise.all([
      appWindow.outerPosition(),
      appWindow.outerSize(),
      appWindow.scaleFactor(),
    ]);
    const scale = scaleFactor || 1;
    return {
      x: Math.round(
        position.x / scale + size.width / scale - WIDGET_WIDTH - WIDGET_MARGIN,
      ),
      y: Math.round(position.y / scale + TITLEBAR_CLEARANCE),
    };
  } catch {
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (!monitor) {
      return { x: WIDGET_MARGIN, y: WIDGET_MARGIN };
    }
    const scale = monitor.scaleFactor || 1;
    return {
      x: Math.round(
        monitor.position.x / scale +
          monitor.size.width / scale -
          WIDGET_WIDTH -
          WIDGET_MARGIN,
      ),
      y: Math.round(monitor.position.y / scale + TITLEBAR_CLEARANCE),
    };
  }
}

/**
 * Open the floating capture widget when a meeting capture starts. The widget
 * loads the same Vite bundle at `?widget=1`, which the app entry guard renders
 * as the compact CaptureWidget instead of the full app. No-op outside Tauri and
 * idempotent if the widget is already open.
 */
export async function openCaptureWidget(meetingId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { LogicalPosition } = await import("@tauri-apps/api/window");
  const position = await captureWidgetPosition();

  const existing = await WebviewWindow.getByLabel(WIDGET_LABEL);
  if (existing) {
    try {
      await existing.setPosition(new LogicalPosition(position.x, position.y));
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
    x: position.x,
    y: position.y,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
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
