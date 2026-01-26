// ABOUTME: File explorer panel with folder selection and tree view.
// ABOUTME: Provides VS Code-like file browsing for local projects.

import { open } from "@tauri-apps/plugin-dialog";
import { type Component, createSignal, Show } from "solid-js";
import { type FileEntry, listDirectory } from "@/lib/tauri-bridge";
import {
  type FileNode,
  fileTreeState,
  setNodeChildren,
  setNodes,
  setRootPath,
} from "@/stores/fileTree";
import { FileTree } from "./FileTree";

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
      const message =
        err instanceof Error ? err.message : "Failed to open folder";
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
      const message =
        err instanceof Error ? err.message : "Failed to load folder";
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
    const findNode = (
      nodes: FileNode[],
      targetPath: string,
    ): FileNode | null => {
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
    <div class="flex flex-col h-full bg-card">
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground m-0">
          Explorer
        </h3>
        <button
          type="button"
          class="flex items-center justify-center w-6 h-6 p-0 bg-transparent border-none rounded cursor-pointer transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleOpenFolder}
          title="Open Folder"
          disabled={isLoading()}
        >
          📂
        </button>
      </div>

      <Show when={error()}>
        <div class="flex items-center justify-between gap-2 px-4 py-2 bg-destructive/10 text-destructive text-xs">
          <span>{error()}</span>
          <button
            type="button"
            class="px-1.5 py-0.5 bg-transparent border-none text-destructive cursor-pointer text-xs"
            onClick={() => setError(null)}
          >
            ✕
          </button>
        </div>
      </Show>

      <Show when={isLoading()}>
        <div class="flex items-center justify-center gap-2 px-4 py-8 text-muted-foreground text-[13px]">
          <span class="w-4 h-4 border-2 border-border border-t-primary rounded-full animate-spin" />
          <span>Loading...</span>
        </div>
      </Show>

      <Show when={!isLoading()}>
        <Show
          when={fileTreeState.rootPath}
          fallback={
            <div class="flex flex-col items-center justify-center gap-4 px-4 py-12 text-center">
              <p class="m-0 text-muted-foreground text-[13px]">
                No folder open
              </p>
              <button
                type="button"
                class="px-4 py-2 bg-primary border-none rounded text-primary-foreground text-[13px] font-medium cursor-pointer transition-opacity hover:opacity-90"
                onClick={handleOpenFolder}
              >
                Open Folder
              </button>
            </div>
          }
        >
          <div class="flex flex-col flex-1 min-h-0">
            <div class="flex items-center justify-between px-4 py-2 bg-muted border-b border-border">
              <span
                class="text-[13px] font-medium text-foreground overflow-hidden text-ellipsis whitespace-nowrap"
                title={fileTreeState.rootPath || ""}
              >
                {getRootFolderName()}
              </span>
              <button
                type="button"
                class="flex items-center justify-center w-5 h-5 p-0 bg-transparent border-none rounded text-xs text-muted-foreground cursor-pointer transition-all hover:bg-muted hover:text-foreground"
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
