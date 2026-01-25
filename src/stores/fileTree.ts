import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
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
export function updateNode(
  path: string,
  updates: Partial<FileNode>
): void {
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

export { fileTreeState, expandedPaths };
