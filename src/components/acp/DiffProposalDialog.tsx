// ABOUTME: Diff proposal review dialog for agent file edits.
// ABOUTME: Shows Monaco diff editor with accept/reject buttons before writing to disk.

import type * as Monaco from "monaco-editor";
import type { Component } from "solid-js";
import { createSignal, onCleanup, onMount } from "solid-js";
import { getMonaco } from "@/lib/editor";
import type { DiffProposalEvent } from "@/stores/acp.store";
import { acpStore } from "@/stores/acp.store";

export interface DiffProposalDialogProps {
  proposal: DiffProposalEvent;
}

function countDiffLines(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let added = 0;
  let removed = 0;
  for (const line of newLines) {
    if (!oldSet.has(line)) added++;
  }
  for (const line of oldLines) {
    if (!newSet.has(line)) removed++;
  }
  return { added, removed };
}

function guessLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    rs: "rust",
    py: "python",
    json: "json",
    css: "css",
    html: "html",
    md: "markdown",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    bash: "shell",
  };
  return map[ext] ?? "plaintext";
}

export const DiffProposalDialog: Component<DiffProposalDialogProps> = (
  props,
) => {
  let containerRef: HTMLDivElement | undefined;
  let diffEditor: Monaco.editor.IStandaloneDiffEditor | undefined;
  const [_ready, setReady] = createSignal(false);

  const stats = () =>
    countDiffLines(props.proposal.oldText, props.proposal.newText);
  const fileName = () => {
    const parts = props.proposal.path.split("/");
    return parts[parts.length - 1];
  };

  onMount(() => {
    if (!containerRef) return;
    try {
      const monaco = getMonaco();
      const language = guessLanguage(props.proposal.path);

      const originalModel = monaco.editor.createModel(
        props.proposal.oldText,
        language,
      );
      const modifiedModel = monaco.editor.createModel(
        props.proposal.newText,
        language,
      );

      diffEditor = monaco.editor.createDiffEditor(containerRef, {
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: "on",
        glyphMargin: false,
        folding: false,
        renderOverviewRuler: false,
        theme: "vs-dark",
        fontSize: 12,
      });

      diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel,
      });

      setReady(true);
    } catch (err) {
      console.error("[DiffProposalDialog] Failed to create diff editor:", err);
    }
  });

  onCleanup(() => {
    if (diffEditor) {
      const model = diffEditor.getModel();
      diffEditor.dispose();
      model?.original?.dispose();
      model?.modified?.dispose();
    }
  });

  function handleAccept() {
    acpStore.respondToDiffProposal(props.proposal.proposalId, true);
  }

  function handleReject() {
    acpStore.respondToDiffProposal(props.proposal.proposalId, false);
  }

  return (
    <div class="border border-border rounded-lg my-2 bg-surface-1 overflow-hidden">
      <div class="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <span class="text-base shrink-0">{"\u270F"}</span>
        <span class="font-semibold text-[13px] text-foreground">
          Review Edit
        </span>
        <span
          class="ml-auto font-[var(--font-mono)] text-xs text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap max-w-[50%]"
          title={props.proposal.path}
        >
          {fileName()}
        </span>
      </div>

      <div
        class="h-[300px] min-h-[150px] max-h-[60vh] overflow-hidden resize-y"
        ref={containerRef}
      />

      <div class="flex gap-2 px-4 py-2.5 border-t border-border items-center">
        <span class="text-[11px] text-muted-foreground mr-auto">
          <span class="text-success">+{stats().added}</span>
          {" / "}
          <span class="text-destructive">-{stats().removed}</span>
        </span>
        <button
          class="px-4 py-1.5 rounded-md border-none text-xs font-medium cursor-pointer transition-opacity duration-150 hover:opacity-85 bg-surface-3 text-muted-foreground"
          onClick={handleReject}
        >
          Reject
        </button>
        <button
          class="px-4 py-1.5 rounded-md border-none text-xs font-medium cursor-pointer transition-opacity duration-150 hover:opacity-85 bg-success text-white"
          onClick={handleAccept}
        >
          Accept
        </button>
      </div>
    </div>
  );
};
