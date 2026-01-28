// ABOUTME: Editor content panel without file tree for resizable layout.
// ABOUTME: Shows file tabs, Monaco editor, and file viewers.

import type * as Monaco from "monaco-editor";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  Show,
} from "solid-js";
import {
  setAddToChatHandler,
  setExplainCodeHandler,
  setImproveCodeHandler,
  setInlineEditHandler,
} from "@/lib/editor";
import { saveTab } from "@/lib/files/service";
import { editorStore } from "@/stores/editor.store";
import { setSelectedPath } from "@/stores/fileTree";
import {
  getActiveTab,
  setTabDirty,
  tabsState,
  updateTabContent,
} from "@/stores/tabs";
import { FileTabs } from "./FileTabs";
import { ImageViewer } from "./ImageViewer";
import { InlineEditWidget } from "./InlineEditWidget";
import { MarkdownPreview } from "./MarkdownPreview";
import { MonacoEditor } from "./MonacoEditor";
import { PdfViewer } from "./PdfViewer";

// State for inline edit widget
interface InlineEditState {
  editor: Monaco.editor.IStandaloneCodeEditor;
  selection: Monaco.Selection;
  originalCode: string;
  language: string;
  filePath: string;
}

interface EditorContentProps {
  onClose?: () => void;
}

export const EditorContent: Component<EditorContentProps> = (props) => {
  const [editorContent, setEditorContent] = createSignal("");
  const [activeFilePath, setActiveFilePath] = createSignal<string | null>(null);
  const [showPreview, setShowPreview] = createSignal(false);
  const [inlineEditState, setInlineEditState] =
    createSignal<InlineEditState | null>(null);

  // Register all context menu handlers
  onMount(() => {
    // Cmd+K: Inline edit with AI
    setInlineEditHandler((code, language, filePath, selection, editor) => {
      setInlineEditState({
        editor,
        selection,
        originalCode: code,
        language,
        filePath,
      });
    });

    // Add to Chat: Set selection as context (no auto-send)
    setAddToChatHandler((code, language, filePath) => {
      const lines = code.split("\n");
      editorStore.setSelectionWithAction(
        code,
        filePath,
        { startLine: 1, endLine: lines.length },
        language,
        "add-to-chat",
      );
    });

    // Explain Code: Set selection and trigger explain prompt
    setExplainCodeHandler((code, language, filePath) => {
      const lines = code.split("\n");
      editorStore.setSelectionWithAction(
        code,
        filePath,
        { startLine: 1, endLine: lines.length },
        language,
        "explain",
      );
    });

    // Improve Code: Set selection and trigger improve prompt
    setImproveCodeHandler((code, language, filePath) => {
      const lines = code.split("\n");
      editorStore.setSelectionWithAction(
        code,
        filePath,
        { startLine: 1, endLine: lines.length },
        language,
        "improve",
      );
    });
  });

  // Check if current file is markdown
  const isMarkdownFile = createMemo(() => {
    const path = activeFilePath();
    if (!path) return false;
    return (
      path.toLowerCase().endsWith(".md") ||
      path.toLowerCase().endsWith(".markdown")
    );
  });

  // Check if current file is an image
  const isImageFile = createMemo(() => {
    const path = activeFilePath();
    if (!path) return false;
    const ext = path.toLowerCase().split(".").pop();
    return ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(
      ext || "",
    );
  });

  // Check if current file is a PDF
  const isPdfFile = createMemo(() => {
    const path = activeFilePath();
    if (!path) return false;
    return path.toLowerCase().endsWith(".pdf");
  });

  // Sync editor content with active tab
  createEffect(() => {
    const activeId = tabsState.activeTabId;
    const activeTab = tabsState.tabs.find((tab) => tab.id === activeId);
    if (activeTab) {
      setActiveFilePath(activeTab.filePath);
      setEditorContent(activeTab.content);
      setSelectedPath(activeTab.filePath);
    } else {
      setActiveFilePath(null);
      setEditorContent("");
    }
  });

  function handleEditorChange(value: string) {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    updateTabContent(activeTab.id, value);
    setEditorContent(value);
  }

  async function handleEditorDirtyChange(isDirty: boolean) {
    const activeTab = getActiveTab();
    if (activeTab) {
      setTabDirty(activeTab.id, isDirty);
    }
  }

  async function handleSave() {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    try {
      await saveTab(activeTab.id, activeTab.filePath, activeTab.content);
    } catch (error) {
      console.error("Failed to save file:", error);
    }
  }

  // Handle Cmd/Ctrl+S to save
  function handleKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
  }

  // Handle inline edit accept - apply the new code
  function handleInlineEditAccept(newCode: string) {
    const state = inlineEditState();
    if (!state) return;

    // Apply the edit via Monaco's executeEdits
    state.editor.executeEdits("seren.inlineEdit", [
      {
        range: state.selection,
        text: newCode,
      },
    ]);

    // Close the widget
    setInlineEditState(null);

    // Focus back on editor
    state.editor.focus();
  }

  // Handle inline edit reject - just close the widget
  function handleInlineEditReject() {
    const state = inlineEditState();
    setInlineEditState(null);

    // Focus back on editor if we have a reference
    state?.editor.focus();
  }

  return (
    <div
      class="flex flex-col h-full bg-card text-foreground"
      onKeyDown={handleKeyDown}
    >
      <Show when={props.onClose}>
        <div class="shrink-0 flex justify-between items-center px-3 py-2 border-b border-[rgba(148,163,184,0.15)] bg-[#161b22]">
          <span class="text-xs font-medium text-[#8b949e]">Editor</span>
          <button
            type="button"
            class="bg-transparent border-none text-[#8b949e] cursor-pointer px-1.5 py-0.5 text-sm leading-none hover:text-[#e6edf3]"
            onClick={props.onClose}
            title="Close Editor"
          >
            ×
          </button>
        </div>
      </Show>
      <div class="shrink-0 border-b border-[rgba(148,163,184,0.15)]">
        <FileTabs
          isMarkdown={isMarkdownFile()}
          showPreview={showPreview()}
          onTogglePreview={() => setShowPreview((prev) => !prev)}
        />
      </div>
      <div
        class={`flex-1 min-h-0 relative flex ${showPreview() && isMarkdownFile() ? "flex-row" : ""}`}
      >
        <Show
          when={activeFilePath()}
          fallback={
            <div class="h-full flex items-center justify-center p-6">
              <div class="text-center max-w-[320px]">
                <span class="text-5xl block mb-4 opacity-60">📝</span>
                <h2 class="m-0 mb-2 text-xl font-medium text-foreground">
                  No file open
                </h2>
                <p class="m-0 mb-5 text-muted-foreground leading-normal">
                  Select a file from the explorer, or use{" "}
                  <kbd class="bg-[rgba(148,163,184,0.2)] px-1.5 py-0.5 rounded font-inherit text-[0.9em]">
                    {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+O
                  </kbd>{" "}
                  to open a file.
                </p>
              </div>
            </div>
          }
        >
          {(filePath) => (
            <Show
              when={isImageFile()}
              fallback={
                <Show
                  when={isPdfFile()}
                  fallback={
                    <>
                      <div class="flex-1 min-w-0 h-full">
                        <MonacoEditor
                          filePath={filePath()}
                          value={editorContent()}
                          onChange={handleEditorChange}
                          onDirtyChange={handleEditorDirtyChange}
                        />
                      </div>
                      <Show when={showPreview() && isMarkdownFile()}>
                        <MarkdownPreview content={editorContent()} />
                      </Show>
                    </>
                  }
                >
                  <PdfViewer filePath={filePath()} />
                </Show>
              }
            >
              <ImageViewer filePath={filePath()} />
            </Show>
          )}
        </Show>
      </div>

      {/* Inline Edit Widget (Cmd+K) */}
      <Show when={inlineEditState()}>
        {(state) => (
          <InlineEditWidget
            editor={state().editor}
            selection={state().selection}
            originalCode={state().originalCode}
            language={state().language}
            filePath={state().filePath}
            onAccept={handleInlineEditAccept}
            onReject={handleInlineEditReject}
          />
        )}
      </Show>
    </div>
  );
};
