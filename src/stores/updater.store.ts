import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { createStore } from "solid-js/store";
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

async function initUpdater(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!isTauriRuntime()) {
    setState({ status: "unsupported" });
    return;
  }

  await checkForUpdates();
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
    console.log("[Updater] Checking for updates...");
    const update = await check();

    if (update) {
      console.log("[Updater] Update available:", update.version);
      pendingUpdate = update;
      setState({
        status: "available",
        availableVersion: update.version,
        lastChecked: Date.now(),
        error: null,
      });
    } else {
      console.log("[Updater] No update available");
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

  console.log("[Updater] Starting download and install...");
  let downloaded = 0;
  setState({
    status: "downloading",
    error: null,
    downloadedBytes: 0,
    totalBytes: 0,
    progressPercent: 0,
  });

  try {
    await pendingUpdate.downloadAndInstall(
      (progress: {
        event: string;
        data: { contentLength?: number; chunkLength?: number };
      }) => {
        if (progress.event === "Started" && progress.data.contentLength) {
          const total = progress.data.contentLength;
          console.log(`[Updater] Download started, size: ${total} bytes`);
          setState({ totalBytes: total });
        } else if (progress.event === "Progress" && progress.data.chunkLength) {
          downloaded += progress.data.chunkLength;
          const percent =
            state.totalBytes > 0
              ? Math.min(Math.round((downloaded / state.totalBytes) * 100), 100)
              : 0;
          setState({ downloadedBytes: downloaded, progressPercent: percent });
        } else if (progress.event === "Finished") {
          console.log("[Updater] Download finished, installing...");
          setState({ status: "installing", progressPercent: 100 });
        }
      },
    );
    console.log("[Updater] Install complete, relaunching...");
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
