import { createStore } from "solid-js/store";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { telemetry } from "@/services/telemetry";

export type UpdateStatus =
  | "idle"
  | "unsupported"
  | "checking"
  | "up_to_date"
  | "available"
  | "deferred"
  | "installing"
  | "error";

interface UpdaterState {
  status: UpdateStatus;
  availableVersion?: string;
  lastChecked?: number;
  error?: string | null;
}

const [state, setState] = createStore<UpdaterState>({
  status: "idle",
  error: null,
});

let initialized = false;
let pendingUpdate: Update | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as Record<string, unknown>).__TAURI_IPC__);
}

async function initUpdater(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!isTauriRuntime()) {
    setState({ status: "unsupported" });
    return;
  }

  await checkForUpdates();
}

async function checkForUpdates(manual = false): Promise<void> {
  if (!isTauriRuntime()) {
    setState({ status: "unsupported" });
    return;
  }

  setState({ status: "checking", error: null });

  try {
    const result = await check();
    if (result) {
      pendingUpdate = result;
      setState({
        status: "available",
        availableVersion: result.version,
        lastChecked: Date.now(),
        error: null,
      });
    } else {
      pendingUpdate = null;
      setState({
        status: manual ? "up_to_date" : "up_to_date",
        availableVersion: undefined,
        lastChecked: Date.now(),
        error: null,
      });
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    telemetry.captureError(err, { type: "updater", phase: "check" });
    setState({ status: "error", error: err.message });
  }
}

async function installAvailableUpdate(): Promise<void> {
  if (!isTauriRuntime() || !pendingUpdate) return;
  setState({ status: "installing" });

  try {
    await pendingUpdate.downloadAndInstall();
    await relaunch();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    telemetry.captureError(err, { type: "updater", phase: "install" });
    setState({ status: "available", error: err.message });
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
