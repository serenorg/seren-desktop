// ABOUTME: File tree component for displaying folder structure in the sidebar.
// ABOUTME: Supports right-click context menu with file operations.

import { invoke } from "@tauri-apps/api/core";
import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import {
  ContextMenu,
  type ContextMenuItem,
} from "@/components/common/ContextMenu";
import { openFolder } from "@/lib/files/service";
import { chatStore } from "@/stores/chat.store";
import {
  type FileNode,
  fileTreeState,
  isExpanded,
  refreshDirectory,
  setSelectedPath,
  toggleExpanded,
} from "@/stores/fileTree";

interface FileTreeProps {
  onFileSelect?: (path: string) => void;
  onDirectoryToggle?: (path: string, expanded: boolean) => void;
  onOpenFolder?: () => void;
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

  // Clipboard state for cut/paste operations
  const [_clipboardNode, setClipboardNode] = createSignal<{
    node: FileNode;
    operation: "cut" | "copy";
  } | null>(null);

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

  // Cut file/folder (mark for move)
  const handleCut = (node: FileNode) => {
    setClipboardNode({ node, operation: "cut" });
  };

  // Copy file path to clipboard
  const handleCopyPath = async (node: FileNode) => {
    try {
      await navigator.clipboard.writeText(node.path);
    } catch (err) {
      console.error("Failed to copy path:", err);
    }
  };

  // Copy relative path to clipboard
  const handleCopyRelativePath = async (node: FileNode) => {
    try {
      const rootPath = fileTreeState.rootPath;
      let relativePath = node.path;
      if (rootPath && node.path.startsWith(rootPath)) {
        relativePath = node.path.slice(rootPath.length);
        // Remove leading slash
        if (relativePath.startsWith("/")) {
          relativePath = relativePath.slice(1);
        }
      }
      await navigator.clipboard.writeText(relativePath);
    } catch (err) {
      console.error("Failed to copy relative path:", err);
    }
  };

  // Add file to current chat
  const handleAddToChat = async (node: FileNode) => {
    if (node.isDirectory) return;
    try {
      const content = await invoke<string>("read_file", { path: node.path });
      const message = `Here is the content of \`${node.name}\`:\n\n\`\`\`\n${content}\n\`\`\``;
      chatStore.setPendingInput(message);
      // Navigate to chat panel
      window.dispatchEvent(
        new CustomEvent("seren:open-panel", { detail: "chat" }),
      );
    } catch (err) {
      console.error("Failed to add file to chat:", err);
    }
  };

  // Add file to new chat
  const handleAddToNewChat = async (node: FileNode) => {
    if (node.isDirectory) return;
    try {
      const content = await invoke<string>("read_file", { path: node.path });
      const message = `Here is the content of \`${node.name}\`:\n\n\`\`\`\n${content}\n\`\`\``;
      await chatStore.createConversation(`File: ${node.name}`);
      chatStore.setPendingInput(message);
      // Navigate to chat panel
      window.dispatchEvent(
        new CustomEvent("seren:open-panel", { detail: "chat" }),
      );
    } catch (err) {
      console.error("Failed to add file to new chat:", err);
    }
  };

  // Add file to agent
  const handleAddToAgent = async (node: FileNode) => {
    if (node.isDirectory) return;
    try {
      const content = await invoke<string>("read_file", { path: node.path });
      const message = `Here is the content of \`${node.name}\`:\n\n\`\`\`\n${content}\n\`\`\``;
      chatStore.setPendingInput(message);
      // Navigate to chat panel
      window.dispatchEvent(
        new CustomEvent("seren:open-panel", { detail: "chat" }),
      );
    } catch (err) {
      console.error("Failed to add file to agent:", err);
    }
  };

  // Add file to new agent session
  const handleAddToNewAgent = async (node: FileNode) => {
    if (node.isDirectory) return;
    try {
      const content = await invoke<string>("read_file", { path: node.path });
      const message = `Here is the content of \`${node.name}\`:\n\n\`\`\`\n${content}\n\`\`\``;
      chatStore.setPendingInput(message);
      // Navigate to chat panel
      window.dispatchEvent(
        new CustomEvent("seren:open-panel", { detail: "chat" }),
      );
    } catch (err) {
      console.error("Failed to add file to new agent:", err);
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
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

    // Reveal in Finder/Explorer (top item like Cursor)
    items.push({
      label: isMac ? "Reveal in Finder" : "Reveal in Explorer",
      icon: "📂",
      shortcut: isMac ? "⌥⌘R" : "Shift+Alt+R",
      onClick: () => handleRevealInFinder(node),
    });

    items.push({ label: "", separator: true, onClick: () => {} });

    // Add to Chat/Agent options (only for files)
    if (!node.isDirectory) {
      items.push({
        label: "Add File to Seren Chat",
        icon: "💬",
        onClick: () => handleAddToChat(node),
      });

      items.push({
        label: "Add File to Seren Agent",
        icon: "🤖",
        onClick: () => handleAddToAgent(node),
      });

      items.push({
        label: "Add File to New Seren Chat",
        icon: "💬",
        onClick: () => handleAddToNewChat(node),
      });

      items.push({
        label: "Add File to New Seren Agent",
        icon: "🤖",
        onClick: () => handleAddToNewAgent(node),
      });

      items.push({ label: "", separator: true, onClick: () => {} });
    }

    // Cut/Copy operations
    items.push({
      label: "Cut",
      icon: "✂️",
      shortcut: isMac ? "⌘X" : "Ctrl+X",
      onClick: () => handleCut(node),
    });

    if (!node.isDirectory) {
      items.push({
        label: "Copy",
        icon: "📋",
        shortcut: isMac ? "⌘C" : "Ctrl+C",
        onClick: () => handleCopy(node),
      });
    }

    items.push({ label: "", separator: true, onClick: () => {} });

    // Path operations
    items.push({
      label: "Copy Path",
      icon: "📎",
      shortcut: isMac ? "⌥⌘C" : "Shift+Alt+C",
      onClick: () => handleCopyPath(node),
    });

    items.push({
      label: "Copy Relative Path",
      icon: "📎",
      shortcut: isMac ? "⇧⌥⌘C" : "Ctrl+Shift+Alt+C",
      onClick: () => handleCopyRelativePath(node),
    });

    items.push({ label: "", separator: true, onClick: () => {} });

    // File operations
    items.push({
      label: "Rename",
      icon: "✏️",
      shortcut: "Enter",
      onClick: () => handleRename(node),
    });

    items.push({
      label: "Delete",
      icon: "🗑️",
      shortcut: isMac ? "⌘⌫" : "Delete",
      onClick: () => handleDelete(node),
    });

    return items;
  };

  return (
    <div
      class="h-full overflow-y-auto overflow-x-hidden text-[15px] select-none"
      role="tree"
      aria-label="File explorer"
      data-testid="file-tree"
    >
      <Show when={folderName()}>
        <div class="py-2 px-3 font-semibold text-foreground uppercase text-base tracking-wider border-b border-border">
          <span class="overflow-hidden text-ellipsis whitespace-nowrap block">
            {folderName()}
          </span>
        </div>
      </Show>
      <Show
        when={fileTreeState.nodes.length > 0}
        fallback={
          <div class="p-6 text-center flex flex-col items-center gap-3">
            <p class="text-muted-foreground text-sm">No folder open</p>
            <button
              type="button"
              class="flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium cursor-pointer transition-colors hover:bg-primary/90"
              onClick={() => props.onOpenFolder?.() ?? openFolder()}
              title="Open Folder"
            >
              <span class="text-lg">+</span>
              <span>Open Folder</span>
            </button>
          </div>
        }
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
    <div class="w-full">
      <div
        class={`flex items-center gap-1.5 py-1 px-2 cursor-pointer rounded mx-1 my-px transition-colors duration-100 ${
          isSelected() ? "bg-accent" : "hover:bg-muted focus:bg-muted"
        } ${isRenaming() ? "bg-accent" : ""} ${props.node.isDirectory ? "font-medium" : ""}`}
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
        <span class="shrink-0 w-4 text-center text-sm">{icon()}</span>
        <Show
          when={isRenaming()}
          fallback={
            <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground">
              {props.node.name}
            </span>
          }
        >
          <input
            ref={renameInputRef}
            type="text"
            class="flex-1 bg-surface-1 border border-primary rounded text-foreground text-[13px] py-0.5 px-1.5 outline-none min-w-0 focus:border-primary focus:shadow-[0_0_0_2px_rgba(56,189,248,0.3)]"
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
          <span class="text-muted-foreground text-xs">...</span>
        </Show>
      </div>

      <Show when={props.node.isDirectory && expanded() && props.node.children}>
        <div role="group">
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
