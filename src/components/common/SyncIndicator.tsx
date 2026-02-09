// ABOUTME: Sync status indicator component.
// ABOUTME: Shows current sync status with visual feedback (idle, syncing, synced, error).

import { type Component, onCleanup, onMount } from "solid-js";
import {
  startFileWatcherForIndexing,
  stopFileWatcherForIndexing,
} from "@/lib/indexing/file-watcher";
import { type SyncStatus, syncStore } from "@/stores/sync.store";

/**
 * Get icon for sync status.
 */
function getStatusIcon(status: SyncStatus): string {
  switch (status) {
    case "syncing":
      return "↻";
    case "synced":
      return "✓";
    case "error":
      return "✗";
    default:
      return "○";
  }
}

/**
 * Get label for sync status.
 */
function getStatusLabel(status: SyncStatus): string {
  switch (status) {
    case "syncing":
      return "Syncing";
    case "synced":
      return "Synced";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

/**
 * Get status-specific classes.
 */
function getStatusClasses(status: SyncStatus): string {
  switch (status) {
    case "syncing":
      return "text-blue-400 [&_.sync-icon]:animate-spin";
    case "synced":
      return "text-success";
    case "error":
      return "text-destructive hover:bg-destructive/20";
    default:
      return "text-muted-foreground [&_.sync-icon]:opacity-50";
  }
}

export const SyncIndicator: Component = () => {
  onMount(() => {
    syncStore.init();
    // Start file watcher for semantic indexing
    startFileWatcherForIndexing();
  });

  onCleanup(() => {
    syncStore.cleanup();
    // Stop file watcher for semantic indexing
    stopFileWatcherForIndexing();
  });

  return (
    <div
      class={`flex items-center gap-1 py-0.5 px-2 rounded text-xs cursor-default transition-all duration-200 ${getStatusClasses(syncStore.status)}`}
      title={syncStore.message || getStatusLabel(syncStore.status)}
    >
      <span class="sync-icon text-sm leading-none">
        {getStatusIcon(syncStore.status)}
      </span>
      <span class="text-[11px]">{getStatusLabel(syncStore.status)}</span>
    </div>
  );
};
