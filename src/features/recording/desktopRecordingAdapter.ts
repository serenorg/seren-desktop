// ABOUTME: Desktop host adapter for the recording UI.
// ABOUTME: Bridges recording-core contracts to Tauri commands without leaking IPC into UI packages.

import {
  DEFAULT_RECORDING_TARGETS,
  type RecordingBrowserExtensionReadiness,
  type RecordingCaptureWindow,
  type RecordingCaptureWindowPreview,
  type RecordingHostAdapter,
  type RecordingMarkerKind,
  type RecordingPermissionKey,
  type RecordingPermissionPreflight,
  type RecordingSession,
  type RecordingStartRequest,
  type RecordingTarget,
} from "@seren/recording-core";
import { isTauriRuntime } from "@/lib/tauri-bridge";

async function getInvoke(): Promise<
  typeof import("@tauri-apps/api/core").invoke | null
> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

function browserTargets(): RecordingTarget[] {
  return DEFAULT_RECORDING_TARGETS.map((target) => ({
    ...target,
    isAvailable: false,
    limitations: [
      "Workflow recording is available from the Seren Desktop native runtime.",
    ],
  }));
}

function browserPermissionPreflight(): RecordingPermissionPreflight {
  return {
    platform: "browser",
    checks: [
      {
        key: "screen_recording",
        status: "unsupported",
        label: "Screen recording",
        message:
          "Native workflow recording permissions are only checked in Seren Desktop.",
        canRequest: false,
        requiredFor: ["screen", "window", "browser"],
      },
      {
        key: "microphone",
        status: "unsupported",
        label: "Microphone",
        message:
          "Native workflow recording permissions are only checked in Seren Desktop.",
        canRequest: false,
        requiredFor: ["screen", "window", "browser"],
      },
      {
        key: "camera",
        status: "unsupported",
        label: "Camera",
        message:
          "Native workflow recording permissions are only checked in Seren Desktop.",
        canRequest: false,
        requiredFor: [],
      },
      {
        key: "accessibility",
        status: "unsupported",
        label: "Accessibility",
        message:
          "Native workflow tracing permissions are only checked in Seren Desktop.",
        canRequest: false,
        requiredFor: ["browser"],
      },
    ],
  };
}

function browserExtensionReadiness(): RecordingBrowserExtensionReadiness {
  return {
    status: "unknown",
    label: "Browser extension",
    message:
      "High-fidelity DOM tracing requires the Seren Workflow Recorder extension and an attachable Chromium tab.",
    canContinueWithFallback: true,
    bannerDisclosure:
      'Chrome may show a "Seren is debugging this browser" banner while DOM tracing is active.',
  };
}

export const desktopRecordingAdapter: RecordingHostAdapter = {
  async listTargets(): Promise<RecordingTarget[]> {
    const invoke = await getInvoke();
    if (!invoke) return browserTargets();
    return await invoke<RecordingTarget[]>("recording_list_targets");
  },

  async listCaptureWindows(): Promise<RecordingCaptureWindow[]> {
    const invoke = await getInvoke();
    if (!invoke) return [];
    return await invoke<RecordingCaptureWindow[]>(
      "recording_list_capture_windows",
    );
  },

  async captureWindowPreview(
    windowId: string,
  ): Promise<RecordingCaptureWindowPreview> {
    const invoke = await getInvoke();
    if (!invoke) {
      throw new Error("Window previews are only available in Seren Desktop.");
    }
    return await invoke<RecordingCaptureWindowPreview>(
      "recording_capture_window_preview",
      { windowId },
    );
  },

  async clearWindowPreviews(): Promise<void> {
    const invoke = await getInvoke();
    if (!invoke) return;
    await invoke("recording_clear_window_previews");
  },

  async checkPermissions(): Promise<RecordingPermissionPreflight> {
    const invoke = await getInvoke();
    if (!invoke) return browserPermissionPreflight();
    return await invoke<RecordingPermissionPreflight>(
      "recording_check_permissions",
    );
  },

  async checkBrowserExtension(): Promise<RecordingBrowserExtensionReadiness> {
    return browserExtensionReadiness();
  },

  async requestPermission(
    key: RecordingPermissionKey,
  ): Promise<RecordingPermissionPreflight> {
    const invoke = await getInvoke();
    if (!invoke) return browserPermissionPreflight();
    return await invoke<RecordingPermissionPreflight>(
      "recording_request_permission",
      { key },
    );
  },

  async openPermissionSettings(key: RecordingPermissionKey): Promise<void> {
    const invoke = await getInvoke();
    if (!invoke) return;
    await invoke("recording_open_permission_settings", { key });
  },

  async start(request: RecordingStartRequest): Promise<RecordingSession> {
    const invoke = await getInvoke();
    if (!invoke) {
      throw new Error("Workflow recording is only available in Seren Desktop.");
    }
    return await invoke<RecordingSession>("recording_start", { request });
  },

  async stop(): Promise<RecordingSession | null> {
    const invoke = await getInvoke();
    if (!invoke) return null;
    return await invoke<RecordingSession | null>("recording_stop");
  },

  async addMarker(kind: RecordingMarkerKind): Promise<void> {
    const invoke = await getInvoke();
    if (!invoke) return;
    await invoke("recording_add_marker", { kind });
  },
};
