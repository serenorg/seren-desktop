// ABOUTME: File tree component for displaying folder structure in the sidebar.
// ABOUTME: Supports right-click context menu with file operations.

import { invoke } from "@tauri-apps/api/core";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import {
  ContextMenu,
  type ContextMenuItem,
} from "@/components/common/ContextMenu";
import {
  type FileNode,
  fileTreeState,
  isExpanded,
  refreshDirectory,
  setSelectedPath,
  toggleExpanded,
} from "@/stores/fileTree";
import "./FileTree.css";

interface FileTreeProps {
  onFileSelect?: (path: string) => void;
  onDirectoryToggle?: (path: string, expanded: boolean) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(
    null,
  );
  const [renameState, setRenameState] = createSignal<{
    path: string;
    name: string;
  } | null>(null);

  const folderName = createMemo(() => {
    if (!fileTreeState.rootPath) return null;
    const parts = fileTreeState.rootPath.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2];
  });

  const handleContextMenu = (e: MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  // Copy file content to clipboard
  const handleCopy = async (node: FileNode) => {
    if (node.isDirectory) return;
    try {
      const content = await invoke<string>("read_file", { path: node.path });
      await navigator.clipboard.writeText(content);
    } catch (err) {
      console.error("Failed to copy file:", err);
    }
  };

  // Copy file path to clipboard
  const handleCopyPath = async (node: FileNode) => {
    try {
      await navigator.clipboard.writeText(node.path);
    } catch (err) {
      console.error("Failed to copy path:", err);
    }
  };

  // Start rename mode
  const handleRename = (node: FileNode) => {
    setRenameState({ path: node.path, name: node.name });
  };

  // Complete rename operation
  const handleRenameSubmit = async (oldPath: string, newName: string) => {
    const dir = oldPath.substring(0, oldPath.lastIndexOf("/"));
    const newPath = `${dir}/${newName}`;

    try {
      await invoke("rename_path", { oldPath, newPath });
      // Refresh the parent directory
      await refreshDirectory(dir);
    } catch (err) {
      console.error("Failed to rename:", err);
    } finally {
      setRenameState(null);
    }
  };

  // Delete file or directory
  const handleDelete = async (node: FileNode) => {
    const confirmDelete = window.confirm(
      `Delete "${node.name}"?${node.isDirectory ? " This will delete all contents." : ""}`,
    );
    if (!confirmDelete) return;

    try {
      await invoke("delete_path", { path: node.path });
      // Refresh the parent directory
      const dir = node.path.substring(0, node.path.lastIndexOf("/"));
      await refreshDirectory(dir);
    } catch (err) {
      console.error("Failed to delete:", err);
      alert(`Failed to delete: ${err}`);
    }
  };

  // Reveal in Finder
  const handleRevealInFinder = async (node: FileNode) => {
    try {
      await invoke("reveal_in_file_manager", { path: node.path });
    } catch (err) {
      console.error("Failed to reveal in finder:", err);
    }
  };

  const getContextMenuItems = (node: FileNode): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    if (!node.isDirectory) {
      items.push({
        label: "Copy",
        icon: "📋",
        onClick: () => handleCopy(node),
      });
    }

    items.push({
      label: "Copy Path",
      icon: "📎",
      onClick: () => handleCopyPath(node),
    });

    items.push({ label: "", separator: true, onClick: () => {} });

    items.push({
      label: "Rename",
      icon: "✏️",
      onClick: () => handleRename(node),
    });

    items.push({
      label: "Delete",
      icon: "🗑️",
      onClick: () => handleDelete(node),
    });

    items.push({ label: "", separator: true, onClick: () => {} });

    items.push({
      label: "Reveal in Finder",
      icon: "📂",
      onClick: () => handleRevealInFinder(node),
    });

    return items;
  };

  return (
    <div
      class="file-tree"
      role="tree"
      aria-label="File explorer"
      data-testid="file-tree"
    >
      <Show when={folderName()}>
        <div class="file-tree-header">
          <span class="file-tree-folder-name">{folderName()}</span>
        </div>
      </Show>
      <Show
        when={fileTreeState.nodes.length > 0}
        fallback={<div class="file-tree-empty">No folder open</div>}
      >
        <For each={fileTreeState.nodes}>
          {(node) => (
            <FileTreeNode
              node={node}
              depth={0}
              onFileSelect={props.onFileSelect}
              onDirectoryToggle={props.onDirectoryToggle}
              onContextMenu={handleContextMenu}
              renameState={renameState()}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={() => setRenameState(null)}
            />
          )}
        </For>
      </Show>

      <Show when={contextMenu()}>
        {(menu) => (
          <ContextMenu
            items={getContextMenuItems(menu().node)}
            x={menu().x}
            y={menu().y}
            onClose={closeContextMenu}
          />
        )}
      </Show>
    </div>
  );
};

interface FileTreeNodeProps {
  node: FileNode;
  depth: number;
  onFileSelect?: (path: string) => void;
  onDirectoryToggle?: (path: string, expanded: boolean) => void;
  onContextMenu: (e: MouseEvent, node: FileNode) => void;
  renameState: { path: string; name: string } | null;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
}

const FileTreeNode: Component<FileTreeNodeProps> = (props) => {
  const expanded = createMemo(() => isExpanded(props.node.path));
  const isSelected = createMemo(
    () => fileTreeState.selectedPath === props.node.path,
  );
  const isRenaming = createMemo(
    () => props.renameState?.path === props.node.path,
  );

  let renameInputRef: HTMLInputElement | undefined;

  function handleClick() {
    if (isRenaming()) return; // Don't navigate while renaming

    if (props.node.isDirectory) {
      const newExpanded = !expanded();
      toggleExpanded(props.node.path);
      props.onDirectoryToggle?.(props.node.path, newExpanded);
    } else {
      setSelectedPath(props.node.path);
      props.onFileSelect?.(props.node.path);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isRenaming()) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  }

  function handleContextMenu(e: MouseEvent) {
    props.onContextMenu(e, props.node);
  }

  function handleRenameKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const newName = renameInputRef?.value.trim();
      if (newName && newName !== props.node.name) {
        props.onRenameSubmit(props.node.path, newName);
      } else {
        props.onRenameCancel();
      }
    } else if (e.key === "Escape") {
      props.onRenameCancel();
    }
  }

  function handleRenameBlur() {
    const newName = renameInputRef?.value.trim();
    if (newName && newName !== props.node.name) {
      props.onRenameSubmit(props.node.path, newName);
    } else {
      props.onRenameCancel();
    }
  }

  const icon = createMemo(() => {
    if (props.node.isDirectory) {
      return expanded() ? "📂" : "📁";
    }
    return getFileIcon(props.node.name);
  });

  return (
    <div class="file-tree-node">
      <div
        class="file-tree-item"
        classList={{
          selected: isSelected(),
          directory: props.node.isDirectory,
          renaming: isRenaming(),
        }}
        style={{ "padding-left": `${props.depth * 16 + 8}px` }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        role="treeitem"
        aria-expanded={props.node.isDirectory ? expanded() : undefined}
        aria-selected={isSelected()}
        tabIndex={isRenaming() ? -1 : 0}
        data-testid="file-tree-item"
        data-file-path={props.node.path}
        data-file-type={props.node.isDirectory ? "directory" : "file"}
      >
        <span class="file-tree-icon">{icon()}</span>
        <Show
          when={isRenaming()}
          fallback={<span class="file-tree-name">{props.node.name}</span>}
        >
          <input
            ref={renameInputRef}
            type="text"
            class="file-tree-rename-input"
            value={props.renameState?.name || ""}
            placeholder="Enter new name"
            aria-label="Rename file"
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            onClick={(e) => e.stopPropagation()}
            autofocus
          />
        </Show>
        <Show when={props.node.isLoading}>
          <span class="file-tree-loading">...</span>
        </Show>
      </div>

      <Show when={props.node.isDirectory && expanded() && props.node.children}>
        <div class="file-tree-children" role="group">
          <For each={props.node.children}>
            {(child) => (
              <FileTreeNode
                node={child}
                depth={props.depth + 1}
                onFileSelect={props.onFileSelect}
                onDirectoryToggle={props.onDirectoryToggle}
                onContextMenu={props.onContextMenu}
                renameState={props.renameState}
                onRenameSubmit={props.onRenameSubmit}
                onRenameCancel={props.onRenameCancel}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

/**
 * Get an icon for a file based on its extension.
 */
function getFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const iconMap: Record<string, string> = {
    ts: "📘",
    tsx: "⚛️",
    js: "📒",
    jsx: "⚛️",
    json: "📋",
    html: "🌐",
    css: "🎨",
    scss: "🎨",
    md: "📝",
    py: "🐍",
    rs: "🦀",
    go: "🐹",
    java: "☕",
    rb: "💎",
    php: "🐘",
    sql: "🗃️",
    yaml: "⚙️",
    yml: "⚙️",
    toml: "⚙️",
    gitignore: "🙈",
    dockerfile: "🐳",
    svg: "🖼️",
    png: "🖼️",
    jpg: "🖼️",
    jpeg: "🖼️",
    gif: "🖼️",
  };
  return iconMap[ext] || "📄";
}

export default FileTree;
