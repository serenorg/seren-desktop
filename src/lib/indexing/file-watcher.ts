// ABOUTME: File watcher integration for automatic re-indexing.
// ABOUTME: Listens to file-changed events from sync.rs and triggers incremental re-indexing.

import { fileTreeState } from "@/stores/fileTree";
import { settingsStore } from "@/stores/settings.store";
import { type FileChangeEvent, syncStore } from "@/stores/sync.store";
import { reindexFile } from "./orchestrator";

let unsubscribeFn: (() => void) | null = null;

/**
 * Start listening to file change events and trigger re-indexing.
 * Call this on app startup if indexing is enabled.
 */
export function startFileWatcherForIndexing(): void {
  // Stop existing listener if any
  if (unsubscribeFn) {
    unsubscribeFn();
    unsubscribeFn = null;
  }

  // Subscribe to file changes via syncStore
  unsubscribeFn = syncStore.onFileChange(async (event: FileChangeEvent) => {
    // Check if indexing is enabled
    const indexingEnabled = settingsStore.get("semanticIndexingEnabled");
    if (!indexingEnabled) {
      return;
    }

    const projectPath = fileTreeState.rootPath;
    if (!projectPath) {
      return;
    }

    // Process each changed file
    for (const filePath of event.paths) {
      // Only reindex on modify events (not create/delete for now)
      if (event.kind.includes("Modify")) {
        try {
          await reindexFile(projectPath, filePath);
          console.log("[File Watcher] Re-indexed:", filePath);
        } catch (error) {
          console.error("[File Watcher] Failed to re-index:", filePath, error);
        }
      }
    }
  });
}

/**
 * Stop listening to file change events.
 */
export function stopFileWatcherForIndexing(): void {
  if (unsubscribeFn) {
    unsubscribeFn();
    unsubscribeFn = null;
  }
}
