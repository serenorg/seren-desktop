// ABOUTME: Frontend orchestration for SerenDB chat and meeting history sync.
// ABOUTME: Auto-provisions speech-text storage and schedules foreground sync ticks.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { waitForDatabaseReady } from "@/services/claudeMemory";
import { type Branch, databases } from "@/services/databases";
import { settingsStore } from "@/stores/settings.store";

const HISTORY_SYNC_PROJECT_NAME = "speech-text";
const HISTORY_SYNC_BRANCH_NAME = "production";
const HISTORY_SYNC_DATABASE_NAME = "seren_desktop_history";
const FOREGROUND_SYNC_MS = 15_000;
const BACKGROUND_SYNC_MS = 60_000;

export interface HistorySyncProvisioning {
  projectId: string;
  branchId: string;
  databaseName: string;
}

export interface HistorySyncSummary {
  pushed: number;
  pulled: number;
  backfilled: number;
  queued: number;
  conflicts: number;
}

let syncTimer: number | null = null;
let syncInFlight = false;

function resolveBranch(
  branches: Branch[],
  defaultBranchId: string | null | undefined,
): Branch | undefined {
  return (
    branches.find((branch) => branch.name === HISTORY_SYNC_BRANCH_NAME) ??
    branches.find((branch) => branch.is_default) ??
    branches.find((branch) => branch.id === defaultBranchId) ??
    branches[0]
  );
}

function syncDelayMs(): number {
  return document.visibilityState === "hidden"
    ? BACKGROUND_SYNC_MS
    : FOREGROUND_SYNC_MS;
}

function scheduleNextSync(): void {
  if (syncTimer !== null) {
    window.clearTimeout(syncTimer);
  }
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    void runScheduledSync();
  }, syncDelayMs());
}

async function runScheduledSync(): Promise<void> {
  if (!settingsStore.get("historySyncEnabled")) {
    stopHistorySync();
    return;
  }
  try {
    await runHistorySyncNow();
  } catch (err) {
    console.warn("[HistorySync] scheduled sync failed", err);
  } finally {
    if (settingsStore.get("historySyncEnabled")) {
      scheduleNextSync();
    }
  }
}

/**
 * Resolve the SerenDB project + branch + database that stores durable local
 * history. Idempotent and safe to call before every manual or scheduled sync.
 */
export async function ensureHistorySyncProvisioned(): Promise<HistorySyncProvisioning> {
  const persistedProject = settingsStore.get("historySyncProjectId");
  const persistedBranch = settingsStore.get("historySyncBranchId");
  const persistedDb = settingsStore.get("historySyncDatabaseName");
  if (persistedProject && persistedBranch && persistedDb) {
    return {
      projectId: persistedProject,
      branchId: persistedBranch,
      databaseName: persistedDb,
    };
  }

  const allProjects = await databases.listProjects();
  let project = allProjects.find((p) => p.name === HISTORY_SYNC_PROJECT_NAME);
  if (!project) {
    console.info(
      `[HistorySync] auto-provisioning SerenDB project "${HISTORY_SYNC_PROJECT_NAME}"`,
    );
    project = await databases.createProject(HISTORY_SYNC_PROJECT_NAME);
  }

  let branches = await databases.listBranches(project.id);
  let branch = resolveBranch(branches, project.default_branch_id);
  if (!branch) {
    console.info(
      `[HistorySync] auto-provisioning SerenDB branch "${HISTORY_SYNC_BRANCH_NAME}"`,
    );
    branch = await databases.createBranch(project.id, HISTORY_SYNC_BRANCH_NAME);
    branches = await databases.listBranches(project.id);
    branch = resolveBranch(branches, project.default_branch_id) ?? branch;
  }

  const allDatabases = await databases.listDatabases(project.id, branch.id);
  const database = allDatabases.find(
    (d) => d.name === HISTORY_SYNC_DATABASE_NAME,
  );
  if (!database) {
    console.info(
      `[HistorySync] auto-provisioning SerenDB database "${HISTORY_SYNC_DATABASE_NAME}"`,
    );
    await databases.createDatabase(
      project.id,
      branch.id,
      HISTORY_SYNC_DATABASE_NAME,
    );
  }

  await waitForDatabaseReady(project.id, branch.id, HISTORY_SYNC_DATABASE_NAME);

  settingsStore.update({
    historySyncProjectId: project.id,
    historySyncBranchId: branch.id,
    historySyncDatabaseName: HISTORY_SYNC_DATABASE_NAME,
  });

  return {
    projectId: project.id,
    branchId: branch.id,
    databaseName: HISTORY_SYNC_DATABASE_NAME,
  };
}

export async function runHistorySyncNow(): Promise<HistorySyncSummary> {
  if (!isTauriRuntime()) {
    return { pushed: 0, pulled: 0, backfilled: 0, queued: 0, conflicts: 0 };
  }
  if (syncInFlight) {
    return { pushed: 0, pulled: 0, backfilled: 0, queued: 0, conflicts: 0 };
  }
  syncInFlight = true;
  try {
    const provisioning = await ensureHistorySyncProvisioned();
    const summary = await invoke<HistorySyncSummary>("history_sync_run_now", {
      projectId: provisioning.projectId,
      branchId: provisioning.branchId,
      databaseName: provisioning.databaseName,
    });
    settingsStore.set("historySyncLastSyncedAt", Date.now());
    return summary;
  } finally {
    syncInFlight = false;
  }
}

export function startHistorySync(): void {
  if (!isTauriRuntime()) return;
  if (!settingsStore.get("historySyncEnabled")) return;
  if (syncTimer !== null || syncInFlight) return;
  void runScheduledSync();
}

export function stopHistorySync(): void {
  if (syncTimer !== null) {
    window.clearTimeout(syncTimer);
    syncTimer = null;
  }
}

export async function wipeHistorySyncRemote(
  confirmation: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const provisioning = await ensureHistorySyncProvisioned();
  await invoke("history_sync_wipe_remote", {
    projectId: provisioning.projectId,
    branchId: provisioning.branchId,
    databaseName: provisioning.databaseName,
    confirmation,
  });
  settingsStore.set("historySyncLastSyncedAt", null);
}
