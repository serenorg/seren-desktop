// ABOUTME: Main editor panel with file tree, tabs, and Monaco editor.
// ABOUTME: Provides full-featured code editing with file system integration.

import { Show, createEffect, createSignal, type Component } from "solid-js";
import { FileTree } from "@/components/sidebar/FileTree";
import { FileTabs } from "./FileTabs";
import { MonacoEditor } from "./MonacoEditor";
import { fileTreeState, setSelectedPath } from "@/stores/fileTree";
import {
  tabsState,
  updateTabContent,
  setTabDirty,
  getActiveTab,
} from "@/stores/tabs";
import {
  openFolder,
  openFileInTab,
  loadDirectoryChildren,
  saveTab,
} from "@/lib/files/service";
import { setNodes } from "@/stores/fileTree";
import "./EditorPanel.css";

export const EditorPanel: Component = () => {
  const [editorContent, setEditorContent] = createSignal("");
  const [activeFilePath, setActiveFilePath] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);

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
    try {
      await openFileInTab(path);
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  }

  async function handleDirectoryToggle(path: string, expanded: boolean) {
    if (expanded) {
      try {
        const children = await loadDirectoryChildren(path);
        // Update the node's children in the tree
        setNodes((nodes) =>
          updateNodeChildren(nodes, path, children)
        );
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

  return (
    <div class="editor-panel" onKeyDown={handleKeyDown}>
      <aside class="editor-sidebar">
        <div class="editor-sidebar-header">
          <span class="editor-sidebar-title">Explorer</span>
          <button
            type="button"
            class="editor-open-folder"
            onClick={handleOpenFolder}
            disabled={isLoading()}
            title="Open Folder"
          >
            {isLoading() ? "..." : "📂"}
          </button>
        </div>
        <div class="editor-file-tree">
          <FileTree
            onFileSelect={handleFileSelect}
            onDirectoryToggle={handleDirectoryToggle}
          />
        </div>
      </aside>

      <section class="editor-main">
        <div class="editor-tabs">
          <FileTabs />
        </div>
        <div class="editor-content">
          <Show
            when={activeFilePath()}
            fallback={
              <div class="editor-empty">
                <div class="editor-empty-content">
                  <span class="editor-empty-icon">📝</span>
                  <h2>No file open</h2>
                  <p>
                    Open a folder to browse files, or use{" "}
                    <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+O</kbd>{" "}
                    to open a file.
                  </p>
                  <Show when={!fileTreeState.rootPath}>
                    <button
                      type="button"
                      class="editor-empty-button"
                      onClick={handleOpenFolder}
                    >
                      Open Folder
                    </button>
                  </Show>
                </div>
              </div>
            }
          >
            <MonacoEditor
              filePath={activeFilePath() ?? undefined}
              value={editorContent()}
              onChange={handleEditorChange}
              onDirtyChange={handleEditorDirtyChange}
            />
          </Show>
        </div>
      </section>
    </div>
  );
};

/**
 * Recursively update children for a node in the tree.
 */
function updateNodeChildren(
  nodes: typeof fileTreeState.nodes,
  path: string,
  children: typeof fileTreeState.nodes
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
