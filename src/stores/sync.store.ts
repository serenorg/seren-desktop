// ABOUTME: Sync store for managing file sync status.
// ABOUTME: Listens to Tauri events and provides reactive sync state.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore } from "solid-js/store";

/**
 * Sync status enum matching Rust backend.
 */
export type SyncStatus = "idle" | "syncing" | "synced" | "error";

/**
 * Sync state from the backend.
 */
export interface SyncState {
  status: SyncStatus;
  message: string | null;
  watching_path: string | null;
}

/**
 * File change event from the backend.
 */
export interface FileChangeEvent {
  paths: string[];
  kind: string;
}

const [state, setState] = createStore<SyncState>({
  status: "idle",
  message: null,
  watching_path: null,
});

let statusUnlisten: UnlistenFn | null = null;
let fileChangeUnlisten: UnlistenFn | null = null;
let fileChangeHandlers: ((event: FileChangeEvent) => void)[] = [];

/**
 * Sync store with reactive state and actions.
 */
export const syncStore = {
  /**
   * Get current sync status.
   */
  get status(): SyncStatus {
    return state.status;
  },

  /**
   * Get current sync message.
   */
  get message(): string | null {
    return state.message;
  },

  /**
   * Get the path being watched.
   */
  get watchingPath(): string | null {
    return state.watching_path;
  },

  /**
   * Check if currently watching.
   */
  get isWatching(): boolean {
    return state.status !== "idle";
  },

  /**
   * Start watching a directory.
   */
  async startWatching(path: string): Promise<void> {
    try {
      await invoke("start_watching", { path });
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof Error ? err.message : "Failed to start watching",
      });
      throw err;
    }
  },

  /**
   * Stop watching.
   */
  async stopWatching(): Promise<void> {
    try {
      await invoke("stop_watching");
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to stop watching",
      });
      throw err;
    }
  },

  /**
   * Refresh status from backend.
   */
  async refresh(): Promise<void> {
    try {
      const status = await invoke<SyncState>("get_sync_status");
      setState(status);
    } catch {
      // Ignore refresh errors
    }
  },

  /**
   * Subscribe to file change events.
   */
  onFileChange(handler: (event: FileChangeEvent) => void): () => void {
    fileChangeHandlers.push(handler);
    return () => {
      fileChangeHandlers = fileChangeHandlers.filter((h) => h !== handler);
    };
  },

  /**
   * Initialize event listeners.
   */
  async init(): Promise<void> {
    // Listen for sync status changes
    if (!statusUnlisten) {
      statusUnlisten = await listen<SyncState>("sync-status", (event) => {
        setState(event.payload);
      });
    }

    // Listen for file changes
    if (!fileChangeUnlisten) {
      fileChangeUnlisten = await listen<FileChangeEvent>(
        "file-changed",
        (event) => {
          fileChangeHandlers.forEach((handler) => handler(event.payload));
        },
      );
    }

    // Get initial status
    await this.refresh();
  },

  /**
   * Cleanup event listeners.
   */
  async cleanup(): Promise<void> {
    if (statusUnlisten) {
      statusUnlisten();
      statusUnlisten = null;
    }
    if (fileChangeUnlisten) {
      fileChangeUnlisten();
      fileChangeUnlisten = null;
    }
    fileChangeHandlers = [];
  },
};
