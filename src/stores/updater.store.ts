import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { createStore } from "solid-js/store";
import { verboseRuntimeConsole } from "@/lib/runtime-console";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { telemetry } from "@/services/telemetry";

export type UpdateStatus =
  | "idle"
  | "unsupported"
  | "checking"
  | "up_to_date"
  | "available"
  | "deferred"
  | "downloading"
  | "installing"
  | "error";

interface UpdaterState {
  status: UpdateStatus;
  availableVersion?: string;
  lastChecked?: number;
  error?: string | null;
  downloadedBytes: number;
  totalBytes: number;
  progressPercent: number;
}

const [state, setState] = createStore<UpdaterState>({
  status: "idle",
  error: null,
  downloadedBytes: 0,
  totalBytes: 0,
  progressPercent: 0,
});

let initialized = false;

const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** True when we must not hit the production update channel.
 *
 * Why: `pnpm tauri dev` builds the binary with whatever version is in
 * `src-tauri/tauri.conf.json` (currently a placeholder). The release workflow
 * rewrites that file from the git tag before packaging, so the shipped binary
 * always carries the real semver, but dev builds don't. If the updater runs
 * in dev it compares the placeholder against a real latest.json on R2 and
 * surfaces a spurious "Update available" banner every 15 minutes. Worse,
 * clicking Install would download + apply a production artifact on top of an
 * in-progress dev checkout.
 */
function isDevRuntime(): boolean {
  return import.meta.env.DEV === true;
}

async function initUpdater(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!isTauriRuntime()) {
    setState({ status: "unsupported" });
    return;
  }

  if (isDevRuntime()) {
    verboseRuntimeConsole.debug("[Updater] Dev build — skipping update check");
    setState({ status: "unsupported" });
    return;
  }

  await checkForUpdates();

  // Auto-install on startup only (#1720). Mid-session interval re-checks keep
  // today's manual-pill behavior so the user is not forced to restart while
  // working. The acknowledgement modal (#1794) sets expectations about the
  // 2–7 minute install window during which Seren is killed and has no UI —
  // without it users see "app stopped, nothing happens" and assume failure.
  // OK is the only choice: skipped upgrades mean users on old broken builds.
  if (state.status === "available") {
    await acknowledgeAutoInstall(state.availableVersion);
    await installAvailableUpdate();
  }

  // Re-check every 15 minutes so the badge appears without requiring a restart
  setInterval(() => {
    if (state.status !== "downloading" && state.status !== "installing") {
      checkForUpdates();
    }
  }, UPDATE_CHECK_INTERVAL_MS);
}

// Store the update object for later installation
let pendingUpdate: Awaited<ReturnType<typeof check>> | null = null;

async function checkForUpdates(_manual = false): Promise<void> {
  if (!isTauriRuntime()) {
    setState({ status: "unsupported" });
    return;
  }

  setState({ status: "checking", error: null });

  try {
    verboseRuntimeConsole.debug("[Updater] Checking for updates...");
    const update = await check();

    if (update) {
      verboseRuntimeConsole.debug(
        "[Updater] Update available:",
        update.version,
      );
      pendingUpdate = update;
      setState({
        status: "available",
        availableVersion: update.version,
        lastChecked: Date.now(),
        error: null,
      });
    } else {
      verboseRuntimeConsole.debug("[Updater] No update available");
      pendingUpdate = null;
      setState({
        status: "up_to_date",
        availableVersion: undefined,
        lastChecked: Date.now(),
        error: null,
      });
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("[Updater] Check failed:", err.message);
    telemetry.captureError(err, { type: "updater", phase: "check" });
    setState({ status: "error", error: err.message });
  }
}

async function clearBrowsingDataBeforeRestart(): Promise<void> {
  try {
    verboseRuntimeConsole.debug(
      "[Updater] Clearing webview browsing data before restart...",
    );
    await getCurrentWebview().clearAllBrowsingData();
    verboseRuntimeConsole.debug("[Updater] Webview browsing data cleared");
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn(
      "[Updater] Failed to clear webview browsing data before restart:",
      err.message,
    );
    telemetry.captureError(err, {
      type: "updater",
      phase: "clear_browsing_data",
    });
  }
}

async function acknowledgeAutoInstall(
  version: string | undefined,
): Promise<void> {
  const headline = version
    ? `Seren is updating to v${version}.`
    : "Seren is installing an update.";
  try {
    await message(
      `${headline}\n\nThe app will close for ~3 minutes during install, then reopen automatically. Don't worry if the window disappears — it will come back.`,
      { title: "Update starting", kind: "info", okLabel: "OK" },
    );
  } catch (error) {
    // Dialog plugin failure must not block the install path. Telemetry only.
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn("[Updater] Acknowledgement dialog failed:", err.message);
    telemetry.captureError(err, { type: "updater", phase: "acknowledge" });
  }
}

interface PreInstallReport {
  mcpDrained: boolean;
  terminalsDrained: boolean;
  providerRuntimeDrained: boolean;
  claudeMemoryDrained: boolean;
  handleReleased: boolean;
  lockedNodePath: string | null;
  elapsedMs: number;
}

/** Drain Seren-owned child processes before handing control to the NSIS
 *  installer / macOS updater. Failure to drain on Windows is the root cause
 *  of #2230's "Error opening file for writing: node.exe" — a stale bundled
 *  node.exe child keeps the executable mapped and the installer cannot
 *  overwrite it. The native command also engages a shutdown guard so any
 *  orchestrator run that fires DURING the download (which can take minutes)
 *  cannot re-spawn the runtime mid-install.
 *
 *  On macOS / Linux this is a defensive call — handle locking is not the
 *  issue, but draining MCP/terminal children before the updater swaps the
 *  .app bundle keeps the post-relaunch state clean. */
async function preInstallShutdown(): Promise<PreInstallReport | null> {
  if (!isTauriRuntime()) return null;
  try {
    const report = await invoke<PreInstallReport>("updater_pre_install");
    verboseRuntimeConsole.debug("[Updater] Pre-install drain report:", report);
    if (!report.handleReleased) {
      // Log but continue — the install may still succeed if the lock clears
      // before NSIS reaches the file-replace step. Surfacing as an error
      // here would block users whose runtime drained correctly but where
      // the handle-release poll timed out under heavy Defender scanning.
      console.warn(
        "[Updater] Bundled node handle did not release during pre-install drain:",
        report.lockedNodePath,
      );
      telemetry.captureError(
        new Error(
          `Updater pre-install handle lock: ${report.lockedNodePath ?? "unknown"}`,
        ),
        { type: "updater", phase: "pre_install_handle_lock" },
      );
    }
    return report;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn("[Updater] Pre-install shutdown failed:", err.message);
    telemetry.captureError(err, { type: "updater", phase: "pre_install" });
    return null;
  }
}

async function installAvailableUpdate(): Promise<void> {
  if (!isTauriRuntime()) {
    console.warn("[Updater] Install skipped: not Tauri runtime");
    return;
  }
  if (!pendingUpdate) {
    console.warn("[Updater] Install skipped: no pending update");
    setState({
      status: "error",
      error: "No pending update found. Try checking again.",
    });
    return;
  }

  verboseRuntimeConsole.debug("[Updater] Starting download and install...");
  let downloaded = 0;
  setState({
    status: "downloading",
    error: null,
    downloadedBytes: 0,
    totalBytes: 0,
    progressPercent: 0,
  });

  // Drain Seren-owned children BEFORE the download begins so the shutdown
  // guard stays engaged for the full download+install window. Otherwise the
  // orchestrator can spawn fresh node.exe processes during the multi-minute
  // download and re-lock the bundled runtime by the time NSIS reaches the
  // file-replace step (#2230).
  await preInstallShutdown();

  try {
    await pendingUpdate.downloadAndInstall((progress: DownloadEvent) => {
      if (progress.event === "Started") {
        const total = progress.data.contentLength ?? 0;
        if (total > 0) {
          verboseRuntimeConsole.debug(
            `[Updater] Download started, size: ${total} bytes`,
          );
          setState({ totalBytes: total });
        }
        return;
      }

      if (progress.event === "Progress") {
        downloaded += progress.data.chunkLength;
        const percent =
          state.totalBytes > 0
            ? Math.min(Math.round((downloaded / state.totalBytes) * 100), 100)
            : 0;
        setState({ downloadedBytes: downloaded, progressPercent: percent });
        return;
      }

      verboseRuntimeConsole.debug("[Updater] Download finished, installing...");
      setState({ status: "installing", progressPercent: 100 });
    });
    verboseRuntimeConsole.debug("[Updater] Install complete");
    await clearBrowsingDataBeforeRestart();
    verboseRuntimeConsole.debug("[Updater] Relaunching after install...");
    await relaunch();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("[Updater] Install failed:", err.message);
    telemetry.captureError(err, { type: "updater", phase: "install" });
    setState({ status: "error", error: err.message });
  }
}

function deferUpdate(): void {
  if (state.status !== "available") return;
  setState({ status: "deferred" });
}

export const updaterStore = {
  state,
  initUpdater,
  checkForUpdates,
  installAvailableUpdate,
  deferUpdate,
};
