// ABOUTME: Indexing store for managing semantic code indexing state.
// ABOUTME: Tracks indexing progress, status, and provides actions for index management.

import { createStore } from "solid-js/store";
import {
  getIndexStatus,
  hasProjectIndex,
  type IndexStats,
  initProjectIndex,
} from "@/services/indexing";
import { fileTreeState } from "@/stores/fileTree";

export type IndexingPhase =
  | "idle"
  | "discovering"
  | "chunking"
  | "embedding"
  | "storing"
  | "complete"
  | "error";

interface IndexingState {
  phase: IndexingPhase;
  filesTotal: number;
  filesProcessed: number;
  chunksTotal: number;
  chunksProcessed: number;
  currentFile: string | null;
  estimatedTokens: number;
  error: string | null;
  stats: IndexStats | null;
  hasIndex: boolean;
}

const [state, setState] = createStore<IndexingState>({
  phase: "idle",
  filesTotal: 0,
  filesProcessed: 0,
  chunksTotal: 0,
  chunksProcessed: 0,
  currentFile: null,
  estimatedTokens: 0,
  error: null,
  stats: null,
  hasIndex: false,
});

/**
 * Indexing store with reactive state and actions.
 */
export const indexingStore = {
  /**
   * Get current indexing phase.
   */
  get phase(): IndexingPhase {
    return state.phase;
  },

  /**
   * Get indexing progress (0-1).
   */
  get progress(): number {
    if (state.phase === "idle" || state.phase === "error") return 0;
    if (state.phase === "complete") return 1;

    // Use chunks processed as progress indicator
    if (state.chunksTotal === 0) return 0;
    return state.chunksProcessed / state.chunksTotal;
  },

  /**
   * Get index statistics.
   */
  get stats(): IndexStats | null {
    return state.stats;
  },

  /**
   * Check if project has an index.
   */
  get hasIndex(): boolean {
    return state.hasIndex;
  },

  /**
   * Get current error message.
   */
  get error(): string | null {
    return state.error;
  },

  /**
   * Get current file being processed.
   */
  get currentFile(): string | null {
    return state.currentFile;
  },

  /**
   * Get estimated token cost.
   */
  get estimatedTokens(): number {
    return state.estimatedTokens;
  },

  /**
   * Set indexing phase.
   */
  setPhase(phase: IndexingPhase): void {
    setState("phase", phase);
  },

  /**
   * Update progress counters.
   */
  updateProgress(update: {
    filesTotal?: number;
    filesProcessed?: number;
    chunksTotal?: number;
    chunksProcessed?: number;
    currentFile?: string | null;
    estimatedTokens?: number;
  }): void {
    setState(update);
  },

  /**
   * Set error state.
   */
  setError(error: string): void {
    setState({
      phase: "error",
      error,
    });
  },

  /**
   * Clear error state.
   */
  clearError(): void {
    setState("error", null);
  },

  /**
   * Reset indexing state.
   */
  reset(): void {
    setState({
      phase: "idle",
      filesTotal: 0,
      filesProcessed: 0,
      chunksTotal: 0,
      chunksProcessed: 0,
      currentFile: null,
      estimatedTokens: 0,
      error: null,
    });
  },

  /**
   * Check if current project has an index.
   */
  async checkIndex(): Promise<void> {
    const projectPath = fileTreeState.rootPath;
    if (!projectPath) {
      setState("hasIndex", false);
      return;
    }

    try {
      const exists = await hasProjectIndex(projectPath);
      setState("hasIndex", exists);

      if (exists) {
        const stats = await getIndexStatus(projectPath);
        setState("stats", stats);
      }
    } catch (error) {
      console.error("[Indexing Store] Failed to check index:", error);
      setState("hasIndex", false);
    }
  },

  /**
   * Initialize index for current project.
   */
  async initIndex(): Promise<void> {
    const projectPath = fileTreeState.rootPath;
    if (!projectPath) {
      throw new Error("No project open");
    }

    try {
      const stats = await initProjectIndex(projectPath);
      setState({
        hasIndex: true,
        stats,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to initialize index";
      throw new Error(message);
    }
  },

  /**
   * Refresh index statistics.
   */
  async refreshStats(): Promise<void> {
    const projectPath = fileTreeState.rootPath;
    if (!projectPath) return;

    try {
      const stats = await getIndexStatus(projectPath);
      setState("stats", stats);
    } catch (error) {
      console.error("[Indexing Store] Failed to refresh stats:", error);
    }
  },
};
