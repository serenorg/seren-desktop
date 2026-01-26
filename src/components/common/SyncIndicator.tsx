// ABOUTME: Sync status indicator component.
// ABOUTME: Shows current sync status with visual feedback (idle, syncing, synced, error).

import { type Component, onCleanup, onMount } from "solid-js";
import { type SyncStatus, syncStore } from "@/stores/sync.store";
import "./SyncIndicator.css";

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

export const SyncIndicator: Component = () => {
  onMount(() => {
    syncStore.init();
  });

  onCleanup(() => {
    syncStore.cleanup();
  });

  return (
    <div
      class={`sync-indicator sync-${syncStore.status}`}
      title={syncStore.message || getStatusLabel(syncStore.status)}
    >
      <span class="sync-icon">{getStatusIcon(syncStore.status)}</span>
      <span class="sync-text">{getStatusLabel(syncStore.status)}</span>
    </div>
  );
};
