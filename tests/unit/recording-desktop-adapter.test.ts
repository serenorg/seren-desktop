// ABOUTME: Verifies the desktop recording adapter's host fallback and IPC payloads.
// ABOUTME: Guards the Tauri/native boundary without importing UI package internals.

import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopRecordingAdapter } from "@/features/recording/desktopRecordingAdapter";
import { isTauriRuntime } from "@/lib/tauri-bridge";

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const isTauriRuntimeMock = vi.mocked(isTauriRuntime);
const invokeMock = vi.mocked(invoke);

describe("desktopRecordingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriRuntimeMock.mockReturnValue(false);
  });

  it("returns unavailable built-in targets outside Tauri", async () => {
    const targets = await desktopRecordingAdapter.listTargets();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(targets.map((target) => target.id)).toEqual([
      "screen",
      "window",
      "browser",
    ]);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "screen",
          isAvailable: false,
          limitations: [
            "Workflow recording is available from the Seren Desktop native runtime.",
          ],
        }),
      ]),
    );
  });

  it("returns unsupported permission checks outside Tauri", async () => {
    const preflight = await desktopRecordingAdapter.checkPermissions?.();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(preflight).toEqual({
      platform: "browser",
      checks: expect.arrayContaining([
        expect.objectContaining({
          key: "screen_recording",
          status: "unsupported",
          canRequest: false,
          requiredFor: ["screen", "window", "browser"],
        }),
        expect.objectContaining({
          key: "accessibility",
          status: "unsupported",
          canRequest: false,
          requiredFor: ["browser"],
        }),
      ]),
    });
  });

  it("surfaces browser extension readiness before capture", async () => {
    const readiness = await desktopRecordingAdapter.checkBrowserExtension?.();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(readiness).toEqual({
      status: "unknown",
      label: "Browser extension",
      message:
        "High-fidelity DOM tracing requires the Seren Workflow Recorder extension and an attachable Chromium tab.",
      canContinueWithFallback: true,
      bannerDisclosure:
        'Chrome may show a "Seren is debugging this browser" banner while DOM tracing is active.',
    });
  });

  it("does not open native permission settings outside Tauri", async () => {
    await expect(
      desktopRecordingAdapter.openPermissionSettings?.("screen_recording"),
    ).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not call Tauri commands for browser fallback actions", async () => {
    await expect(
      desktopRecordingAdapter.start({
        targetId: "screen",
        targetKind: "screen",
        prep: {
          goal: "Submit an invoice",
          successState: "Invoice is accepted",
          variableInputs: "Invoice PDF",
          preferences: "Use defaults",
          tosAcknowledged: true,
        },
        includeMicrophone: true,
        includeCamera: false,
        executableUpgrade: true,
      }),
    ).rejects.toThrow("Workflow recording is only available in Seren Desktop.");

    await expect(desktopRecordingAdapter.stop()).resolves.toBeNull();
    await expect(
      desktopRecordingAdapter.addMarker("important"),
    ).resolves.toBeUndefined();
    await expect(
      desktopRecordingAdapter.listCaptureWindows?.(),
    ).resolves.toEqual([]);
    await expect(
      desktopRecordingAdapter.captureWindowPreview?.("123"),
    ).rejects.toThrow("Window previews are only available in Seren Desktop.");
    await expect(
      desktopRecordingAdapter.clearWindowPreviews?.(),
    ).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("passes camelCase requests and marker kinds to Tauri commands", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    invokeMock.mockImplementation(async (command) => {
      if (command === "recording_list_targets") {
        return [
          {
            id: "browser",
            kind: "browser",
            label: "Browser",
            detail: "Capture a browser workflow.",
            isAvailable: false,
            capabilities: ["video", "action_trace", "transcript"],
            limitations: [],
          },
        ];
      }
      if (command === "recording_start") {
        return {
          id: "recording-1",
          targetKind: "browser",
          targetLabel: "Browser",
          startedAtMs: 1234,
          outputDir: null,
          maxVideoHeight: 720,
        };
      }
      if (command === "recording_list_capture_windows") {
        return [
          {
            id: "123",
            platformId: 123,
            pid: 456,
            appName: "Preview App",
            title: "Workflow",
            bounds: { x: 10, y: 20, width: 640, height: 480 },
            isFocused: true,
            isMinimized: false,
            isRecordable: true,
          },
        ];
      }
      if (command === "recording_capture_window_preview") {
        return {
          windowId: "123",
          capturedAtMs: 1234,
          artifactUrl: "file:///tmp/window-preview-123.png",
          mimeType: "image/png",
          width: 640,
          height: 480,
          sizeBytes: 1024,
        };
      }
      if (command === "recording_check_permissions") {
        return {
          platform: "macos",
          checks: [
            {
              key: "screen_recording",
              status: "unknown",
              label: "Screen recording",
              message: "Permission state is checked by the capture backend.",
              canRequest: true,
              requiredFor: ["screen", "window", "browser"],
            },
          ],
        };
      }
      if (command === "recording_stop") {
        return null;
      }
      if (command === "recording_request_permission") {
        return {
          platform: "macos",
          checks: [],
        };
      }
      if (command === "recording_clear_window_previews") {
        return undefined;
      }
      return undefined;
    });

    const request = {
      targetId: "browser",
      targetKind: "browser" as const,
      captureWindowId: null,
      captureWindow: null,
      prep: {
        goal: "Submit an invoice",
        successState: "Invoice is accepted",
        variableInputs: "Invoice PDF",
        preferences: "Use defaults",
        tosAcknowledged: true,
      },
      includeMicrophone: true,
      includeCamera: false,
      executableUpgrade: true,
    };

    await expect(desktopRecordingAdapter.listTargets()).resolves.toHaveLength(
      1,
    );
    await expect(desktopRecordingAdapter.listCaptureWindows?.()).resolves.toEqual(
      [
        expect.objectContaining({
          id: "123",
          appName: "Preview App",
          isRecordable: true,
        }),
      ],
    );
    await expect(
      desktopRecordingAdapter.captureWindowPreview?.("123"),
    ).resolves.toEqual(
      expect.objectContaining({
        windowId: "123",
        mimeType: "image/png",
      }),
    );
    await expect(desktopRecordingAdapter.checkPermissions?.()).resolves.toEqual(
      expect.objectContaining({
        platform: "macos",
      }),
    );
    await expect(desktopRecordingAdapter.start(request)).resolves.toEqual(
      expect.objectContaining({
        id: "recording-1",
        targetKind: "browser",
        outputDir: null,
      }),
    );
    await expect(desktopRecordingAdapter.stop()).resolves.toBeNull();
    await expect(
      desktopRecordingAdapter.addMarker("confirm"),
    ).resolves.toBeUndefined();
    await expect(
      desktopRecordingAdapter.requestPermission?.("screen_recording"),
    ).resolves.toEqual({ platform: "macos", checks: [] });
    await expect(
      desktopRecordingAdapter.openPermissionSettings?.("accessibility"),
    ).resolves.toBeUndefined();
    await expect(
      desktopRecordingAdapter.clearWindowPreviews?.(),
    ).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "recording_list_targets");
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "recording_list_capture_windows",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      3,
      "recording_capture_window_preview",
      { windowId: "123" },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      4,
      "recording_check_permissions",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(5, "recording_start", {
      request,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "recording_stop");
    expect(invokeMock).toHaveBeenNthCalledWith(7, "recording_add_marker", {
      kind: "confirm",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      8,
      "recording_request_permission",
      { key: "screen_recording" },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      9,
      "recording_open_permission_settings",
      { key: "accessibility" },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      10,
      "recording_clear_window_previews",
    );
  });
});
