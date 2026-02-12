// ABOUTME: Inline edit widget for Cmd+K code modification.
// ABOUTME: Shows prompt input, streams AI response, and displays diff preview.

import type * as Monaco from "monaco-editor";
import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  computeSimpleDiff,
  type DiffLine,
  extractCodeFromResponse,
} from "@/lib/editor/diff-utils";
import { streamMessage } from "@/lib/providers";
import { providerStore } from "@/stores/provider.store";

export interface InlineEditWidgetProps {
  editor: Monaco.editor.IStandaloneCodeEditor;
  selection: Monaco.Selection;
  originalCode: string;
  language: string;
  filePath: string;
  onAccept: (newCode: string) => void;
  onReject: () => void;
}

export const InlineEditWidget: Component<InlineEditWidgetProps> = (props) => {
  const [prompt, setPrompt] = createSignal("");
  const [modifiedCode, setModifiedCode] = createSignal("");
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showDiff, setShowDiff] = createSignal(false);

  let inputRef: HTMLInputElement | undefined;
  let widgetRef: HTMLDivElement | undefined;
  let streamController: { cancelled: boolean } | null = null;

  // Position widget below the selection
  const widgetPosition = createMemo(() => {
    const startPos = props.selection.getStartPosition();
    const coords = props.editor.getScrolledVisiblePosition(startPos);
    if (!coords) return { top: 0, left: 0 };

    const editorDom = props.editor.getDomNode();
    if (!editorDom) return { top: 0, left: 0 };

    const editorRect = editorDom.getBoundingClientRect();

    // Position below the selection start, using coords.height for line height
    return {
      top: editorRect.top + coords.top + coords.height + 8,
      left: Math.max(editorRect.left + coords.left, editorRect.left + 20),
    };
  });

  // Compute diff for preview
  const diff = createMemo<DiffLine[]>(() => {
    if (!modifiedCode()) return [];
    return computeSimpleDiff(props.originalCode, modifiedCode());
  });

  // Handle AI streaming
  const handleSubmit = async () => {
    const promptText = prompt().trim();
    if (!promptText || isStreaming()) return;

    setIsStreaming(true);
    setError(null);
    setShowDiff(true);
    setModifiedCode("");

    streamController = { cancelled: false };

    const systemPrompt = `You are a code editor. Modify the following ${props.language} code according to the user's instruction. Return ONLY the modified code without any explanation, markdown fences, or additional text.

Code to modify:
${props.originalCode}

Instruction: ${promptText}

Modified code:`;

    try {
      const stream = streamMessage({
        messages: [{ role: "user", content: systemPrompt }],
        model: providerStore.activeModel,
        stream: true,
      });

      let fullContent = "";

      for await (const chunk of stream) {
        if (streamController?.cancelled) break;
        fullContent += chunk;
        // Extract code from response (handles markdown fences)
        const extracted = extractCodeFromResponse(fullContent);
        setModifiedCode(extracted);
      }
    } catch (err) {
      if (!streamController?.cancelled) {
        setError((err as Error).message || "Failed to generate code");
      }
    } finally {
      setIsStreaming(false);
      streamController = null;
    }
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onReject();
    } else if (e.key === "Enter" && !e.shiftKey && !isStreaming()) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Click outside to close
  createEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (widgetRef && !widgetRef.contains(e.target as Node)) {
        props.onReject();
      }
    };

    // Delay adding listener to avoid immediate close
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);

    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    });
  });

  // Auto-focus input on mount
  onMount(() => {
    inputRef?.focus();
  });

  // Cancel stream on unmount
  onCleanup(() => {
    if (streamController) {
      streamController.cancelled = true;
    }
  });

  return (
    <div
      ref={widgetRef}
      class="fixed z-[10000] w-[450px] max-w-[calc(100vw-40px)] bg-surface-1 border border-surface-3 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
      style={{
        top: `${widgetPosition().top}px`,
        left: `${widgetPosition().left}px`,
      }}
    >
      {/* Header */}
      <div class="flex items-center justify-between px-3 py-2 border-b border-surface-3">
        <span class="text-xs text-muted-foreground font-medium">
          Edit with AI
        </span>
        <button
          type="button"
          onClick={props.onReject}
          class="text-muted-foreground hover:text-foreground text-lg leading-none"
        >
          x
        </button>
      </div>

      {/* Prompt Input */}
      <div class="p-3 border-b border-surface-3">
        <input
          ref={inputRef}
          type="text"
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the change (e.g., 'make this async')"
          class="w-full px-3 py-2 bg-background border border-surface-3 rounded text-sm text-foreground outline-none focus:border-primary placeholder:text-muted-foreground/70"
          disabled={isStreaming()}
        />
        <div class="flex gap-2 mt-2">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isStreaming() || !prompt().trim()}
            class="px-3 py-1.5 bg-success/70 text-white text-xs font-medium rounded hover:bg-success/85 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isStreaming() ? "Generating..." : "Generate"}
          </button>
          <button
            type="button"
            onClick={props.onReject}
            class="px-3 py-1.5 bg-transparent text-muted-foreground border border-surface-3 text-xs rounded hover:bg-surface-2 hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>

      {/* Diff Preview */}
      <Show when={showDiff()}>
        <div class="max-h-[300px] overflow-y-auto">
          <Show
            when={diff().length > 0}
            fallback={
              <div class="p-3 text-xs text-muted-foreground text-center">
                {isStreaming() ? "Generating..." : "No changes yet"}
              </div>
            }
          >
            <div class="font-mono text-xs">
              <For each={diff()}>
                {(line) => (
                  <div
                    class={`px-3 py-0.5 ${
                      line.type === "removed"
                        ? "bg-destructive/15 text-destructive/80"
                        : line.type === "added"
                          ? "bg-success/15 text-success"
                          : "text-muted-foreground"
                    }`}
                  >
                    <span class="select-none mr-2 opacity-60 inline-block w-3">
                      {line.type === "removed"
                        ? "-"
                        : line.type === "added"
                          ? "+"
                          : " "}
                    </span>
                    <span class="whitespace-pre">{line.content || " "}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Accept/Reject Buttons */}
        <Show when={!isStreaming() && modifiedCode()}>
          <div class="flex gap-2 p-3 border-t border-surface-3">
            <button
              type="button"
              onClick={() => props.onAccept(modifiedCode())}
              class="flex-1 px-3 py-2 bg-success/70 text-white text-sm font-medium rounded hover:bg-success/85"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={props.onReject}
              class="flex-1 px-3 py-2 bg-surface-2 text-foreground border border-surface-3 text-sm font-medium rounded hover:bg-surface-3"
            >
              Reject
            </button>
          </div>
        </Show>
      </Show>

      {/* Error Display */}
      <Show when={error()}>
        <div class="p-3 text-xs text-destructive bg-destructive/10 border-t border-surface-3">
          {error()}
        </div>
      </Show>
    </div>
  );
};
