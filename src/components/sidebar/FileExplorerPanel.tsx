// ABOUTME: File explorer panel with folder selection and tree view.
// ABOUTME: Provides VS Code-like file browsing for local projects.

import { Component, Show, createSignal } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { FileTree } from "./FileTree";
import {
  fileTreeState,
  setRootPath,
  setNodes,
  setNodeChildren,
  type FileNode,
} from "@/stores/fileTree";
import { listDirectory, type FileEntry } from "@/lib/tauri-bridge";
import "./FileExplorerPanel.css";

interface FileExplorerPanelProps {
  onFileSelect?: (path: string) => void;
}

/**
 * Convert FileEntry from Tauri to FileNode for the tree.
 */
function entryToNode(entry: FileEntry): FileNode {
  return {
    name: entry.name,
    path: entry.path,
    isDirectory: entry.is_directory,
    children: entry.is_directory ? undefined : undefined,
    isLoading: false,
  };
}

export const FileExplorerPanel: Component<FileExplorerPanelProps> = (props) => {
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /**
   * Open folder picker and load the selected directory.
   */
  async function handleOpenFolder() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Folder",
      });

      if (selected && typeof selected === "string") {
        await loadFolder(selected);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open folder";
      setError(message);
    }
  }

  /**
   * Load a folder and its contents into the file tree.
   */
  async function loadFolder(path: string) {
    setIsLoading(true);
    setError(null);

    try {
      const entries = await listDirectory(path);
      const nodes = entries.map(entryToNode);

      setRootPath(path);
      setNodes(nodes);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load folder";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }

  /**
   * Handle directory expansion - load children if needed.
   */
  async function handleDirectoryToggle(path: string, expanded: boolean) {
    if (!expanded) return;

    // Check if children already loaded
    const findNode = (nodes: FileNode[], targetPath: string): FileNode | null => {
      for (const node of nodes) {
        if (node.path === targetPath) return node;
        if (node.children) {
          const found = findNode(node.children, targetPath);
          if (found) return found;
        }
      }
      return null;
    };

    const node = findNode(fileTreeState.nodes, path);
    if (node?.children && node.children.length > 0) {
      return; // Already loaded
    }

    // Load children
    try {
      const entries = await listDirectory(path);
      const children = entries.map(entryToNode);
      setNodeChildren(path, children);
    } catch (err) {
      console.error("Failed to load directory:", err);
    }
  }

  /**
   * Handle file selection.
   */
  function handleFileSelect(path: string) {
    props.onFileSelect?.(path);
  }

  /**
   * Get the folder name from the root path.
   */
  function getRootFolderName(): string {
    const rootPath = fileTreeState.rootPath;
    if (!rootPath) return "";
    const parts = rootPath.split(/[/\\]/);
    return parts[parts.length - 1] || rootPath;
  }

  return (
    <div class="file-explorer-panel">
      <div class="file-explorer-header">
        <h3 class="file-explorer-title">Explorer</h3>
        <button
          type="button"
          class="file-explorer-open-btn"
          onClick={handleOpenFolder}
          title="Open Folder"
          disabled={isLoading()}
        >
          📂
        </button>
      </div>

      <Show when={error()}>
        <div class="file-explorer-error">
          <span>{error()}</span>
          <button type="button" onClick={() => setError(null)}>✕</button>
        </div>
      </Show>

      <Show when={isLoading()}>
        <div class="file-explorer-loading">
          <span class="file-explorer-spinner" />
          <span>Loading...</span>
        </div>
      </Show>

      <Show when={!isLoading()}>
        <Show
          when={fileTreeState.rootPath}
          fallback={
            <div class="file-explorer-empty">
              <p>No folder open</p>
              <button
                type="button"
                class="file-explorer-open-folder-btn"
                onClick={handleOpenFolder}
              >
                Open Folder
              </button>
            </div>
          }
        >
          <div class="file-explorer-workspace">
            <div class="file-explorer-workspace-header">
              <span class="file-explorer-workspace-name" title={fileTreeState.rootPath || ""}>
                {getRootFolderName()}
              </span>
              <button
                type="button"
                class="file-explorer-close-btn"
                onClick={() => {
                  setRootPath("");
                  setNodes([]);
                }}
                title="Close Folder"
              >
                ✕
              </button>
            </div>
            <FileTree
              onFileSelect={handleFileSelect}
              onDirectoryToggle={handleDirectoryToggle}
            />
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default FileExplorerPanel;
