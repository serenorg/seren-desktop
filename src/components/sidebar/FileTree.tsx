import { For, Show, createMemo, type Component } from "solid-js";
import {
  fileTreeState,
  isExpanded,
  toggleExpanded,
  setSelectedPath,
  type FileNode,
} from "@/stores/fileTree";
import "./FileTree.css";

interface FileTreeProps {
  onFileSelect?: (path: string) => void;
  onDirectoryToggle?: (path: string, expanded: boolean) => void;
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const folderName = createMemo(() => {
    if (!fileTreeState.rootPath) return null;
    const parts = fileTreeState.rootPath.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2];
  });

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
            />
          )}
        </For>
      </Show>
    </div>
  );
};

interface FileTreeNodeProps {
  node: FileNode;
  depth: number;
  onFileSelect?: (path: string) => void;
  onDirectoryToggle?: (path: string, expanded: boolean) => void;
}

const FileTreeNode: Component<FileTreeNodeProps> = (props) => {
  const expanded = createMemo(() => isExpanded(props.node.path));
  const isSelected = createMemo(
    () => fileTreeState.selectedPath === props.node.path
  );

  function handleClick() {
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
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
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
        }}
        style={{ "padding-left": `${props.depth * 16 + 8}px` }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="treeitem"
        aria-expanded={props.node.isDirectory ? expanded() : undefined}
        aria-selected={isSelected()}
        tabIndex={0}
        data-testid="file-tree-item"
        data-file-path={props.node.path}
        data-file-type={props.node.isDirectory ? "directory" : "file"}
      >
        <span class="file-tree-icon">{icon()}</span>
        <span class="file-tree-name">{props.node.name}</span>
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
