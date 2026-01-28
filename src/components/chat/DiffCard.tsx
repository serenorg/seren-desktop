// ABOUTME: Card component for displaying file diffs from agent operations.
// ABOUTME: Shows a compact inline diff with option to view in Monaco editor.

import type { Component } from "solid-js";
import { createMemo, createSignal, Show } from "solid-js";
import type { DiffEvent } from "@/services/acp";

interface DiffCardProps {
  diff: DiffEvent;
  onViewInEditor?: (diff: DiffEvent) => void;
}

export const DiffCard: Component<DiffCardProps> = (props) => {
  const [isExpanded, setIsExpanded] = createSignal(false);

  const fileName = createMemo(() => {
    const path = props.diff.path;
    return path.split("/").pop() ?? path;
  });

  const diffLines = createMemo(() => {
    const oldLines = props.diff.oldText.split("\n");
    const newLines = props.diff.newText.split("\n");

    // Simple line-by-line diff (could be improved with a proper diff algorithm)
    const lines: Array<{
      type: "added" | "removed" | "unchanged";
      content: string;
    }> = [];

    // For a simple view, show removed lines first, then added
    // In practice, you'd use a real diff algorithm
    const maxLines = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLines; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine === newLine) {
        if (oldLine !== undefined) {
          lines.push({ type: "unchanged", content: oldLine });
        }
      } else {
        if (oldLine !== undefined) {
          lines.push({ type: "removed", content: oldLine });
        }
        if (newLine !== undefined) {
          lines.push({ type: "added", content: newLine });
        }
      }
    }

    return lines;
  });

  const stats = createMemo(() => {
    const lines = diffLines();
    return {
      added: lines.filter((l) => l.type === "added").length,
      removed: lines.filter((l) => l.type === "removed").length,
    };
  });

  return (
    <div class="my-2 bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-3 py-2 bg-[#21262d] border-b border-[#30363d]">
        <div class="flex items-center gap-2">
          <svg
            class="w-4 h-4 text-[#8b949e]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            role="img"
            aria-label="File"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span class="text-sm font-medium text-[#e6edf3]">{fileName()}</span>
          <span class="text-xs text-[#8b949e]">{props.diff.path}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-green-500">+{stats().added}</span>
          <span class="text-xs text-red-500">-{stats().removed}</span>
          <Show when={props.onViewInEditor}>
            <button
              type="button"
              class="px-2 py-1 text-xs bg-[#30363d] text-[#e6edf3] rounded hover:bg-[#484f58] transition-colors"
              onClick={() => props.onViewInEditor?.(props.diff)}
            >
              View Diff
            </button>
          </Show>
          <button
            type="button"
            class="p-1 text-[#8b949e] hover:text-[#e6edf3] transition-colors"
            onClick={() => setIsExpanded(!isExpanded())}
          >
            <svg
              class={`w-4 h-4 transition-transform ${isExpanded() ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              role="img"
              aria-label={isExpanded() ? "Collapse" : "Expand"}
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Diff Content */}
      <Show when={isExpanded()}>
        <div class="max-h-[300px] overflow-auto font-mono text-xs">
          {diffLines().map((line) => (
            <div
              class={`px-3 py-0.5 border-l-2 ${
                line.type === "added"
                  ? "bg-[rgba(63,185,80,0.15)] border-green-500 text-green-300"
                  : line.type === "removed"
                    ? "bg-[rgba(248,81,73,0.15)] border-red-500 text-red-300"
                    : "bg-transparent border-transparent text-[#8b949e]"
              }`}
            >
              <span class="inline-block w-4 text-[#484f58] select-none">
                {line.type === "added"
                  ? "+"
                  : line.type === "removed"
                    ? "-"
                    : " "}
              </span>
              <span>{line.content || " "}</span>
            </div>
          ))}
        </div>
      </Show>

      {/* Collapsed Preview */}
      <Show when={!isExpanded()}>
        <div class="px-3 py-2 text-xs text-[#8b949e]">
          {stats().added} addition{stats().added !== 1 ? "s" : ""},{" "}
          {stats().removed} deletion{stats().removed !== 1 ? "s" : ""}
        </div>
      </Show>
    </div>
  );
};
