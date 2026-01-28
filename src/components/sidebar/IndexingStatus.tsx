// ABOUTME: Indexing status component for sidebar display.
// ABOUTME: Shows indexing progress, statistics, and controls.

import { Show, createEffect } from "solid-js";
import { indexingStore } from "@/stores/indexing.store";
import { settingsStore } from "@/stores/settings.store";
import "./IndexingStatus.css";

export function IndexingStatus() {
  // Check if indexing is enabled
  const indexingEnabled = () => settingsStore.get("semanticIndexingEnabled");

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
    <div class="indexing-status">
      <div class="indexing-status-header">
        <span class="indexing-status-title">Codebase Index</span>
        <Show when={indexingStore.hasIndex}>
          <button
            class="indexing-status-refresh"
            onClick={() => indexingStore.refreshStats()}
            title="Refresh statistics"
          >
            ↻
          </button>
        </Show>
      </div>

      <Show
        when={indexingStore.phase !== "idle" && indexingStore.phase !== "complete"}
        fallback={
          <Show
            when={indexingStore.hasIndex && indexingStore.stats}
            fallback={
              <div class="indexing-status-empty">
                <p>No index available</p>
                <p class="indexing-status-hint">
                  Enable semantic search in settings to index your codebase
                </p>
              </div>
            }
          >
            <div class="indexing-status-stats">
              <div class="indexing-stat">
                <span class="indexing-stat-label">Chunks</span>
                <span class="indexing-stat-value">
                  {formatNumber(indexingStore.stats!.total_chunks)}
                </span>
              </div>
              <div class="indexing-stat">
                <span class="indexing-stat-label">Files</span>
                <span class="indexing-stat-value">
                  {formatNumber(indexingStore.stats!.total_files)}
                </span>
              </div>
              <div class="indexing-stat">
                <span class="indexing-stat-label">Last Updated</span>
                <span class="indexing-stat-value">
                  {formatDate(indexingStore.stats!.last_indexed)}
                </span>
              </div>
            </div>
          </Show>
        }
      >
        <div class="indexing-status-progress">
          <div class="indexing-progress-bar">
            <div
              class="indexing-progress-fill"
              style={{ width: `${indexingStore.progress * 100}%` }}
            />
          </div>
          <div class="indexing-progress-info">
            <span class="indexing-phase">{indexingStore.phase}</span>
            <Show when={indexingStore.currentFile}>
              <span class="indexing-current-file">{indexingStore.currentFile}</span>
            </Show>
          </div>
          <Show when={indexingStore.estimatedTokens > 0}>
            <div class="indexing-cost-estimate">
              <span>Estimated: ~{formatNumber(indexingStore.estimatedTokens)} tokens</span>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={indexingStore.error}>
        <div class="indexing-status-error">
          <span class="indexing-error-icon">⚠</span>
          <span class="indexing-error-message">{indexingStore.error}</span>
        </div>
      </Show>
    </div>
  );
}
