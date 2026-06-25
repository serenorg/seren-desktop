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

async function getConvertFileSrc(): Promise<
  typeof import("@tauri-apps/api/core").convertFileSrc | null
> {
  if (!isTauriRuntime()) return null;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc;
}

async function getListen(): Promise<
  typeof import("@tauri-apps/api/event").listen | null
> {
  if (!isTauriRuntime()) return null;
  const { listen } = await import("@tauri-apps/api/event");
  return listen;
}

const EXTERNAL_STOP_EVENT = "recording://external-stop";

interface ExternalStopPayload {
  recordingId: string;
}

function pathFromFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const pathname = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost") {
      return `//${url.hostname}${pathname}`;
    }
    if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
    return pathname;
  } catch {
    return null;
  }
}

function normalizeWindowPreviewArtifactUrl(
  preview: RecordingCaptureWindowPreview,
  convertFileSrc: typeof import("@tauri-apps/api/core").convertFileSrc,
): RecordingCaptureWindowPreview {
  const artifactPath =
    typeof preview.artifactPath === "string" && preview.artifactPath.trim()
      ? preview.artifactPath
      : pathFromFileUrl(preview.artifactUrl);
  if (!artifactPath) return preview;
  return {
    ...preview,
    artifactUrl: convertFileSrc(artifactPath),
  };
}

function externalStopSession(recordingId: string): RecordingSession {
  return {
    id: recordingId,
    targetKind: "screen",
    targetLabel: "Workflow recording",
    startedAtMs: 0,
    outputDir: null,
    maxVideoHeight: 0,
  };
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
    const preview = await invoke<RecordingCaptureWindowPreview>(
      "recording_capture_window_preview",
      { windowId },
    );
    const convertFileSrc = await getConvertFileSrc();
    return convertFileSrc
      ? normalizeWindowPreviewArtifactUrl(preview, convertFileSrc)
      : preview;
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

  releaseSessionArtifacts(_session: RecordingSession): void {
    // Native artifacts are file:// URLs backed by on-disk files; there are no
    // blob: handles to revoke.
  },

  onExternalStop(handler: (session: RecordingSession) => void): () => void {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void getListen().then((listen) => {
      if (!listen || cancelled) return;
      void listen<ExternalStopPayload>(EXTERNAL_STOP_EVENT, (event) => {
        const recordingId = event.payload?.recordingId;
        if (!recordingId) return;
        // The OS ended capture out-of-band; finalize via the stop command to
        // recover the artifact-bearing session, falling back to a minimal
        // session if finalize yielded nothing.
        void desktopRecordingAdapter
          .stop()
          .then((session) =>
            handler(session ?? externalStopSession(recordingId)),
          )
          .catch(() => handler(externalStopSession(recordingId)));
      })
        .then((dispose) => {
          if (cancelled) {
            dispose();
            return;
          }
          unlisten = dispose;
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};
