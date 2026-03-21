// ABOUTME: Tests the updater install sequence around browsing-data clearing.
// ABOUTME: Verifies updates clear the current webview cache before restart without blocking relaunch.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockStoreState,
  isTauriRuntimeMock,
  checkMock,
  relaunchMock,
  clearAllBrowsingDataMock,
  captureErrorMock,
} = vi.hoisted(() => ({
  mockStoreState: {} as Record<string, unknown>,
  isTauriRuntimeMock: vi.fn<() => boolean>(),
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
  clearAllBrowsingDataMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock("solid-js/store", () => ({
  createStore: <T extends Record<string, unknown>>(initial: T) => {
    Object.assign(mockStoreState, initial);
    const setState = (update: Partial<T>) => {
      Object.assign(mockStoreState, update);
    };
    return [mockStoreState, setState];
  },
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: checkMock,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: relaunchMock,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    clearAllBrowsingData: clearAllBrowsingDataMock,
  }),
}));

vi.mock("@/services/telemetry", () => ({
  telemetry: {
    captureError: captureErrorMock,
  },
}));

describe("updaterStore install flow", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.keys(mockStoreState).forEach((key) => delete mockStoreState[key]);
    isTauriRuntimeMock.mockReset();
    checkMock.mockReset();
    relaunchMock.mockReset();
    clearAllBrowsingDataMock.mockReset();
    captureErrorMock.mockReset();
  });

  it("clears browsing data before relaunching an installed update", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const downloadAndInstallMock = vi.fn(async () => {});
    checkMock.mockResolvedValue({
      version: "1.3.53",
      downloadAndInstall: downloadAndInstallMock,
    });
    clearAllBrowsingDataMock.mockResolvedValue(undefined);
    relaunchMock.mockResolvedValue(undefined);

    const { updaterStore } = await import("@/stores/updater.store");

    await updaterStore.checkForUpdates();
    await updaterStore.installAvailableUpdate();

    expect(downloadAndInstallMock).toHaveBeenCalledOnce();
    expect(clearAllBrowsingDataMock).toHaveBeenCalledOnce();
    expect(relaunchMock).toHaveBeenCalledOnce();
    expect(clearAllBrowsingDataMock.mock.invocationCallOrder[0]).toBeLessThan(
      relaunchMock.mock.invocationCallOrder[0],
    );
  });

  it("still relaunches if browsing-data clearing fails", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const downloadAndInstallMock = vi.fn(async () => {});
    checkMock.mockResolvedValue({
      version: "1.3.53",
      downloadAndInstall: downloadAndInstallMock,
    });
    clearAllBrowsingDataMock.mockRejectedValue(new Error("cache denied"));
    relaunchMock.mockResolvedValue(undefined);

    const { updaterStore } = await import("@/stores/updater.store");

    await updaterStore.checkForUpdates();
    await updaterStore.installAvailableUpdate();

    expect(downloadAndInstallMock).toHaveBeenCalledOnce();
    expect(clearAllBrowsingDataMock).toHaveBeenCalledOnce();
    expect(captureErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      type: "updater",
      phase: "clear_browsing_data",
    });
    expect(relaunchMock).toHaveBeenCalledOnce();
  });
});
