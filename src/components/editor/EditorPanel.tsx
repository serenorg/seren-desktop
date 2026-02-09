// ABOUTME: Main editor panel with file tree, tabs, and Monaco editor.
// ABOUTME: Provides full-featured code editing with file system integration.

import type * as Monaco from "monaco-editor";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  Show,
} from "solid-js";
import { FileTree } from "@/components/sidebar/FileTree";
import { IndexingStatus } from "@/components/sidebar/IndexingStatus";
import { OpenClawStatus } from "@/components/sidebar/OpenClawStatus";
import {
  setAddToChatHandler,
  setExplainCodeHandler,
  setImproveCodeHandler,
  setInlineEditHandler,
} from "@/lib/editor";
import {
  loadDirectoryChildren,
  openFileInTab,
  openFolder,
  saveTab,
} from "@/lib/files/service";
import { editorStore } from "@/stores/editor.store";
import { fileTreeState, setNodes, setSelectedPath } from "@/stores/fileTree";
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

export const EditorPanel: Component = () => {
  const [editorContent, setEditorContent] = createSignal("");
  const [activeFilePath, setActiveFilePath] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
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
    console.log("[EditorPanel] Sync effect triggered:", {
      activeId,
      activeTab: activeTab ? {
        id: activeTab.id,
        filePath: activeTab.filePath,
        contentLength: activeTab.content.length
      } : null
    });
    if (activeTab) {
      setActiveFilePath(activeTab.filePath);
      setEditorContent(activeTab.content);
      setSelectedPath(activeTab.filePath);
      console.log("[EditorPanel] Editor content set, first 100 chars:", activeTab.content.substring(0, 100));
    } else {
      setActiveFilePath(null);
      setEditorContent("");
      console.log("[EditorPanel] No active tab, cleared editor");
    }
  });

  async function handleOpenFolder() {
    setIsLoading(true);
    try {
      await openFolder();
    } catch (error) {
      console.error("Failed to open folder:", error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleFileSelect(path: string) {
    console.log("[EditorPanel] handleFileSelect called with:", path);
    try {
      await openFileInTab(path);
      console.log("[EditorPanel] File opened successfully");
    } catch (error) {
      console.error("[EditorPanel] Failed to open file:", error);
    }
  }

  async function handleDirectoryToggle(path: string, expanded: boolean) {
    if (expanded) {
      try {
        const children = await loadDirectoryChildren(path);
        // Update the node's children in the tree
        const updatedNodes = updateNodeChildren(
          fileTreeState.nodes,
          path,
          children,
        );
        setNodes(updatedNodes);
      } catch (error) {
        console.error("Failed to load directory:", error);
      }
    }
  }

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
    <div class="flex h-full bg-card text-foreground" onKeyDown={handleKeyDown}>
      <aside class="w-60 min-w-[180px] max-w-[400px] flex flex-col bg-popover border-r border-[rgba(148,163,184,0.25)]">
        <div class="flex items-center justify-between px-4 py-3 border-b border-[rgba(148,163,184,0.15)]">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Explorer
          </span>
          <button
            type="button"
            class="bg-transparent border-none px-2 py-1 cursor-pointer text-sm rounded transition-colors hover:bg-[rgba(148,163,184,0.15)] disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleOpenFolder}
            disabled={isLoading()}
            title="Open Folder"
          >
            {isLoading() ? "..." : "📂"}
          </button>
        </div>
        <div class="flex-1 overflow-y-auto py-2">
          <FileTree
            onFileSelect={handleFileSelect}
            onDirectoryToggle={handleDirectoryToggle}
          />
        </div>
        <IndexingStatus />
        <OpenClawStatus />
      </aside>

      <section class="flex-1 flex flex-col min-w-0">
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
                    Open a folder to browse files, or use{" "}
                    <kbd class="bg-[rgba(148,163,184,0.2)] px-1.5 py-0.5 rounded font-inherit text-[0.9em]">
                      {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+O
                    </kbd>{" "}
                    to open a file.
                  </p>
                  <Show when={!fileTreeState.rootPath}>
                    <button
                      type="button"
                      class="bg-accent text-white border-none px-6 py-2.5 rounded-md text-[0.95rem] cursor-pointer transition-colors hover:bg-[#4f46e5]"
                      onClick={handleOpenFolder}
                    >
                      Open Folder
                    </button>
                  </Show>
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
      </section>

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

/**
 * Recursively update children for a node in the tree.
 */
function updateNodeChildren(
  nodes: typeof fileTreeState.nodes,
  path: string,
  children: typeof fileTreeState.nodes,
): typeof fileTreeState.nodes {
  return nodes.map((node) => {
    if (node.path === path) {
      return { ...node, children };
    }
    if (node.children) {
      return {
        ...node,
        children: updateNodeChildren(node.children, path, children),
      };
    }
    return node;
  });
}

export default EditorPanel;
