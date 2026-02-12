import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
}

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

interface FileTreeState {
  rootPath: string | null;
  nodes: FileNode[];
  selectedPath: string | null;
}

const [fileTreeState, setFileTreeState] = createStore<FileTreeState>({
  rootPath: null,
  nodes: [],
  selectedPath: null,
});

// Track expanded directories
const [expandedPaths, setExpandedPaths] = createSignal<Set<string>>(new Set());

/**
 * Set the root directory for the file tree.
 */
export function setRootPath(path: string): void {
  setFileTreeState("rootPath", path);
}

/**
 * Set the file tree nodes.
 */
export function setNodes(nodes: FileNode[]): void {
  setFileTreeState("nodes", nodes);
}

/**
 * Update a specific node in the tree.
 */
export function updateNode(path: string, updates: Partial<FileNode>): void {
  function updateRecursive(nodes: FileNode[]): FileNode[] {
    return nodes.map((node) => {
      if (node.path === path) {
        return { ...node, ...updates };
      }
      if (node.children) {
        return { ...node, children: updateRecursive(node.children) };
      }
      return node;
    });
  }
  setFileTreeState("nodes", updateRecursive(fileTreeState.nodes));
}

/**
 * Set children for a directory node.
 */
export function setNodeChildren(path: string, children: FileNode[]): void {
  updateNode(path, { children, isLoading: false });
}

/**
 * Toggle directory expansion state.
 */
export function toggleExpanded(path: string): void {
  setExpandedPaths((prev) => {
    const next = new Set(prev);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    return next;
  });
}

/**
 * Check if a path is expanded.
 */
export function isExpanded(path: string): boolean {
  return expandedPaths().has(path);
}

/**
 * Set the selected file path.
 */
export function setSelectedPath(path: string | null): void {
  setFileTreeState("selectedPath", path);
}

/**
 * Get the current file tree state (readonly).
 */
export function getFileTreeState(): Readonly<FileTreeState> {
  return fileTreeState;
}

/**
 * Convert FileEntry from Tauri to FileNode.
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

/**
 * Refresh a directory's contents after file operations.
 * If the path is the root, refreshes the entire tree.
 * Otherwise, refreshes the children of the specified directory.
 */
export async function refreshDirectory(path: string): Promise<void> {
  try {
    const entries = await invoke<FileEntry[]>("list_directory", { path });
    const children = entries.map(entryToNode);

    // If this is the root path, update the root nodes
    if (path === fileTreeState.rootPath) {
      setNodes(children);
    } else {
      // Update the children of this directory
      setNodeChildren(path, children);
    }
  } catch (err) {
    console.error("Failed to refresh directory:", err);
  }
}

/**
 * Set the root path to ~/Documents/Seren if no project is currently open.
 */
export async function initDefaultRootIfNeeded(): Promise<void> {
  if (fileTreeState.rootPath) return;
  try {
    const defaultDir = await invoke<string>("get_default_project_dir");
    if (defaultDir) {
      setRootPath(defaultDir);
    }
  } catch {
    // Silently ignore — user can still open a folder manually
  }
}

export { fileTreeState, expandedPaths };
