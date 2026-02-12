// ABOUTME: Indexing status component for sidebar display.
// ABOUTME: Shows indexing progress, statistics, and controls.

import { createEffect, createSignal, Show } from "solid-js";
import { runIndexing } from "@/lib/indexing/orchestrator";
import { fileTreeState } from "@/stores/fileTree";
import { indexingStore } from "@/stores/indexing.store";
import { settingsStore } from "@/stores/settings.store";

export function IndexingStatus() {
  // Check if indexing is enabled
  const indexingEnabled = () => settingsStore.get("semanticIndexingEnabled");
  const [isIndexing, setIsIndexing] = createSignal(false);

  // Check for index on mount and when project changes
  createEffect(() => {
    if (indexingEnabled()) {
      indexingStore.checkIndex();
    }
  });

  // Don't render if indexing is disabled
  if (!indexingEnabled()) {
    return null;
  }

  const handleStartIndexing = async () => {
    const projectPath = fileTreeState.rootPath;
    if (!projectPath) {
      alert("No project open. Please open a folder first.");
      return;
    }

    setIsIndexing(true);
    indexingStore.reset();

    try {
      const result = await runIndexing(projectPath);
      console.log("[Indexing] Complete:", result);
    } catch (error) {
      console.error("[Indexing] Failed:", error);
      const message =
        error instanceof Error ? error.message : "Indexing failed";
      alert(`Indexing failed: ${message}`);
    } finally {
      setIsIndexing(false);
    }
  };

  const formatNumber = (num: number) => {
    return num.toLocaleString();
  };

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return "Never";
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    // Less than 1 minute
    if (diff < 60000) return "Just now";

    // Less than 1 hour
    if (diff < 3600000) {
      const mins = Math.floor(diff / 60000);
      return `${mins} min${mins > 1 ? "s" : ""} ago`;
    }

    // Less than 1 day
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    }

    // Format as date
    return date.toLocaleDateString();
  };

  return (
    <div class="p-3 border-t border-border bg-surface-1">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-semibold text-foreground uppercase tracking-[0.5px]">
          Codebase Index
        </span>
        <Show when={indexingStore.hasIndex}>
          <button
            class="bg-transparent border-none text-muted-foreground cursor-pointer text-base px-1.5 py-0.5 rounded transition-all duration-200 hover:bg-surface-2 hover:text-foreground"
            onClick={() => indexingStore.refreshStats()}
            title="Refresh statistics"
          >
            ↻
          </button>
        </Show>
      </div>

      <Show
        when={
          indexingStore.phase !== "idle" && indexingStore.phase !== "complete"
        }
        fallback={
          <Show
            when={indexingStore.hasIndex && indexingStore.stats}
            fallback={
              <div class="py-4 text-center">
                <p class="m-0 text-[13px] text-muted-foreground">
                  No index available
                </p>
                <p class="m-0 text-[11px] text-muted-foreground mt-2 opacity-70">
                  Index your codebase to enable semantic code search
                </p>
                <button
                  class="w-full mt-3 px-3 py-2 bg-primary text-white border-none rounded text-xs font-medium cursor-pointer transition-all duration-200 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleStartIndexing}
                  disabled={isIndexing() || !fileTreeState.rootPath}
                >
                  {isIndexing() ? "Indexing..." : "Start Indexing"}
                </button>
              </div>
            }
          >
            <div class="flex flex-col gap-2">
              <div class="flex justify-between items-center px-2 py-1.5 bg-surface-0 rounded">
                <span class="text-xs text-muted-foreground">Chunks</span>
                <span class="text-[13px] font-medium text-foreground">
                  {formatNumber(indexingStore.stats?.total_chunks)}
                </span>
              </div>
              <div class="flex justify-between items-center px-2 py-1.5 bg-surface-0 rounded">
                <span class="text-xs text-muted-foreground">Files</span>
                <span class="text-[13px] font-medium text-foreground">
                  {formatNumber(indexingStore.stats?.total_files)}
                </span>
              </div>
              <div class="flex justify-between items-center px-2 py-1.5 bg-surface-0 rounded">
                <span class="text-xs text-muted-foreground">Last Updated</span>
                <span class="text-[13px] font-medium text-foreground">
                  {formatDate(indexingStore.stats?.last_indexed)}
                </span>
              </div>
            </div>
            <button
              class="w-full mt-3 px-3 py-2 bg-surface-0 text-foreground border border-border rounded text-xs font-medium cursor-pointer transition-all duration-200 hover:bg-surface-2 hover:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleStartIndexing}
              disabled={isIndexing()}
            >
              {isIndexing() ? "Re-indexing..." : "Re-index Project"}
            </button>
          </Show>
        }
      >
        <div class="py-2">
          <div class="h-1 bg-surface-0 rounded-sm overflow-hidden mb-2">
            <div
              class="h-full bg-primary transition-[width] duration-300 ease-in-out"
              style={{ width: `${indexingStore.progress * 100}%` }}
            />
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium text-primary capitalize">
              {indexingStore.phase}
            </span>
            <Show when={indexingStore.currentFile}>
              <span class="text-[11px] text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                {indexingStore.currentFile}
              </span>
            </Show>
          </div>
          <Show when={indexingStore.estimatedTokens > 0}>
            <div class="mt-2 px-2 py-1.5 bg-surface-0 rounded text-[11px] text-muted-foreground">
              <span>
                Estimated: ~{formatNumber(indexingStore.estimatedTokens)} tokens
              </span>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={indexingStore.error}>
        <div class="flex items-start gap-2 p-2 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded mt-2">
          <span class="text-destructive text-sm shrink-0">⚠</span>
          <span class="text-[11px] text-destructive leading-normal">
            {indexingStore.error}
          </span>
        </div>
      </Show>
    </div>
  );
}
