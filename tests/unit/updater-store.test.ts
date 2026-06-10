// ABOUTME: Tests the updater install sequence around browsing-data clearing.
// ABOUTME: Verifies updates clear the current webview cache before restart without blocking relaunch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockStoreState,
  isTauriRuntimeMock,
  checkMock,
  relaunchMock,
  clearAllBrowsingDataMock,
  captureErrorMock,
  invokeMock,
  messageMock,
} = vi.hoisted(() => ({
  mockStoreState: {} as Record<string, unknown>,
  isTauriRuntimeMock: vi.fn<() => boolean>(),
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
  clearAllBrowsingDataMock: vi.fn(),
  captureErrorMock: vi.fn(),
  invokeMock: vi.fn(),
  messageMock: vi.fn(),
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: messageMock,
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
    invokeMock.mockReset();
    messageMock.mockReset();
    messageMock.mockResolvedValue(undefined);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "updater_install_preflight") {
        return {
          installReady: true,
          currentAppPath: "/Applications/SerenDesktop.app",
          reason: null,
          remediation: null,
        };
      }
      if (command === "updater_pre_install") {
        return {
          mcpDrained: true,
          terminalsDrained: true,
          providerRuntimeDrained: true,
          claudeMemoryDrained: true,
          handleReleased: true,
          lockedNodePath: null,
          elapsedMs: 10,
        };
      }
      return undefined;
    });
    // Vitest sets import.meta.env.DEV=true; the prod-only code paths under
    // test would otherwise short-circuit through isDevRuntime().
    vi.stubEnv("DEV", false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("initUpdater silently installs an available update on startup (#1720)", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const downloadAndInstallMock = vi.fn(async () => {});
    checkMock.mockResolvedValue({
      version: "1.3.53",
      downloadAndInstall: downloadAndInstallMock,
    });
    clearAllBrowsingDataMock.mockResolvedValue(undefined);
    relaunchMock.mockResolvedValue(undefined);

    const { updaterStore } = await import("@/stores/updater.store");

    await updaterStore.initUpdater();

    expect(downloadAndInstallMock).toHaveBeenCalledOnce();
    expect(relaunchMock).toHaveBeenCalledOnce();
  });

  it("initUpdater does not install when no update is available (#1720)", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const downloadAndInstallMock = vi.fn(async () => {});
    checkMock.mockResolvedValue(null);

    const { updaterStore } = await import("@/stores/updater.store");

    await updaterStore.initUpdater();

    expect(downloadAndInstallMock).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("drains Seren-owned children before downloadAndInstall (#2230)", async () => {
    // The bundled node.exe is held open by the provider runtime / MCP
    // children. If we let downloadAndInstall run without draining first,
    // the NSIS file-replace step on Windows fails with "Error opening file
    // for writing: node.exe". Pin the call order so a future refactor that
    // moves the drain after download can't ship without failing this test.
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

    expect(invokeMock).toHaveBeenCalledWith("updater_install_preflight");
    expect(invokeMock).toHaveBeenCalledWith("updater_pre_install");
    expect(downloadAndInstallMock).toHaveBeenCalledOnce();
    const preInstallCallIndex = invokeMock.mock.calls.findIndex(
      (call) => call[0] === "updater_pre_install",
    );
    expect(invokeMock.mock.invocationCallOrder[preInstallCallIndex]).toBeLessThan(
      downloadAndInstallMock.mock.invocationCallOrder[0],
    );
  });

  it("blocks macOS updater installs when running from a mounted DMG (#2273)", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const downloadAndInstallMock = vi.fn(async () => {});
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "updater_install_preflight") {
        return {
          installReady: false,
          currentAppPath: "/Volumes/SerenDesktop/SerenDesktop.app",
          reason: "SerenDesktop is running from a mounted installer volume.",
          remediation:
            "Move SerenDesktop to /Applications, eject the installer disk image, reopen Seren, then install the update.",
        };
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    checkMock.mockResolvedValue({
      version: "3.51.7",
      downloadAndInstall: downloadAndInstallMock,
    });

    const { updaterStore } = await import("@/stores/updater.store");

    await updaterStore.checkForUpdates();
    await updaterStore.installAvailableUpdate();

    expect(downloadAndInstallMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("updater_install_preflight");
    expect(mockStoreState.status).toBe("error");
    expect(mockStoreState.error).toContain("/Applications");
    expect(captureErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      type: "updater",
      phase: "install_preflight",
      currentAppPath: "/Volumes/SerenDesktop/SerenDesktop.app",
    });
  });

  it("continues install when pre-install handle release times out", async () => {
    // The pre-install command can succeed at draining but still report the
    // bundled node handle as locked under heavy Defender scanning. We log
    // and continue rather than block the install — the actual file-replace
    // may still succeed if the kernel flushes the handle by the time NSIS
    // gets there.
    isTauriRuntimeMock.mockReturnValue(true);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "updater_install_preflight") {
        return {
          installReady: true,
          currentAppPath: null,
          reason: null,
          remediation: null,
        };
      }
      return {
        mcpDrained: true,
        terminalsDrained: true,
        providerRuntimeDrained: true,
        claudeMemoryDrained: true,
        handleReleased: false,
        lockedNodePath: "C:\\Users\\u\\AppData\\Local\\SerenDesktop\\embedded-runtime\\win32-x64\\node\\node.exe",
        elapsedMs: 15000,
      };
    });
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
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("pre-install handle lock"),
      }),
      { type: "updater", phase: "pre_install_handle_lock" },
    );
  });

  it("continues install when pre-install command itself fails", async () => {
    // The pre-install command can fail (e.g. permission, IPC race). The
    // updater must not block — the in-app drain is defense in depth on top
    // of the installer-side NSIS hook. Failing here would strand users on
    // broken builds with no path forward.
    isTauriRuntimeMock.mockReturnValue(true);
    invokeMock.mockRejectedValue(new Error("ipc unavailable"));
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
    expect(captureErrorMock).toHaveBeenCalledWith(expect.any(Error), {
      type: "updater",
      phase: "pre_install",
    });
  });

  it("releases the shutdown guard when downloadAndInstall fails (#2230)", async () => {
    // Without releasing, the user is locked out of provider runtime / MCP
    // until they manually restart — terrible UX after a transient download
    // failure. This test pins the failure-path cleanup.
    isTauriRuntimeMock.mockReturnValue(true);
    const downloadAndInstallMock = vi.fn(async () => {
      throw new Error("network drop mid-download");
    });
    checkMock.mockResolvedValue({
      version: "1.3.53",
      downloadAndInstall: downloadAndInstallMock,
    });

    const { updaterStore } = await import("@/stores/updater.store");

    await updaterStore.checkForUpdates();
    await updaterStore.installAvailableUpdate();

    expect(downloadAndInstallMock).toHaveBeenCalledOnce();
    // The first invoke is updater_pre_install (engage), the second after
    // failure is updater_pre_install_release.
    const releaseCall = invokeMock.mock.calls.find(
      (call) => call[0] === "updater_pre_install_release",
    );
    expect(releaseCall).toBeDefined();
    expect(mockStoreState.status).toBe("error");
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
