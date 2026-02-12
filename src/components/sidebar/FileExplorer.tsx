// ABOUTME: Shared file explorer sidebar for the resizable layout.
// ABOUTME: Provides folder opening and file tree navigation.

import { type Component, createSignal } from "solid-js";
import {
  loadDirectoryChildren,
  openFileInTab,
  openFolder,
} from "@/lib/files/service";
import { fileTreeState, setNodes } from "@/stores/fileTree";
import { FileTree } from "./FileTree";

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

export const FileExplorer: Component = () => {
  const [isLoading, setIsLoading] = createSignal(false);

  const handleOpenFolder = async () => {
    setIsLoading(true);
    try {
      await openFolder();
    } catch (error) {
      console.error("Failed to open folder:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = async (path: string) => {
    try {
      await openFileInTab(path);
      // Switch to editor panel to show the opened file
      window.dispatchEvent(
        new CustomEvent("seren:open-panel", { detail: "editor" }),
      );
    } catch (error) {
      console.error("Failed to open file:", error);
    }
  };

  const handleDirectoryToggle = async (path: string, expanded: boolean) => {
    if (expanded) {
      try {
        const children = await loadDirectoryChildren(path);
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
  };

  return (
    <aside class="flex flex-col h-full bg-surface-0 border-r border-surface-2">
      <div class="flex justify-between items-center px-3 py-2.5 border-b border-surface-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Explorer</span>
        <button
          type="button"
          onClick={handleOpenFolder}
          disabled={isLoading()}
          title="Open Folder"
          class="bg-transparent border-none text-muted-foreground cursor-pointer px-1 py-0.5 text-sm leading-none transition-colors hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading() ? "..." : "+"}
        </button>
      </div>
      <div class="flex-1 overflow-y-auto py-1">
        <FileTree
          onFileSelect={handleFileSelect}
          onDirectoryToggle={handleDirectoryToggle}
        />
      </div>
    </aside>
  );
};
