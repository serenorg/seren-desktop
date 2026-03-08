import {
  isBrowserLocalRuntime,
  runtimeInvoke,
} from "@/lib/browser-local-runtime";
import { createSkillsSymlink } from "@/lib/skills/paths";
import {
  createDirectory as createDirectoryBridge,
  createFile as createFileBridge,
  deletePath as deletePathBridge,
  isDirectory as isDirectoryBridge,
  isTauriRuntime,
  listDirectory as listDirectoryBridge,
  pathExists as pathExistsBridge,
  readFile as readFileBridge,
  renamePath as renamePathBridge,
  revealInFileManager as revealInFileManagerBridge,
  writeFile as writeFileBridge,
} from "@/lib/tauri-bridge";
import { type FileNode, setNodes, setRootPath } from "@/stores/fileTree";
import { openTab, setTabDirty } from "@/stores/tabs";

export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

/**
 * Read the contents of a file.
 */
export async function readFile(path: string): Promise<string> {
  return readFileBridge(path);
}

/**
 * Write content to a file.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  return writeFileBridge(path, content);
}

/**
 * List entries in a directory.
 */
export async function listDirectory(path: string): Promise<FileEntry[]> {
  return listDirectoryBridge(path);
}

/**
 * Check if a path exists.
 */
export async function pathExists(path: string): Promise<boolean> {
  return pathExistsBridge(path);
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  return isDirectoryBridge(path);
}

/**
 * Create a new file with optional content.
 */
export async function createFile(
  path: string,
  content?: string,
): Promise<void> {
  return createFileBridge(path, content);
}

/**
 * Create a new directory.
 */
export async function createDirectory(path: string): Promise<void> {
  return createDirectoryBridge(path);
}

/**
 * Delete a file or empty directory.
 */
export async function deletePath(path: string): Promise<void> {
  return deletePathBridge(path);
}

/**
 * Rename/move a file or directory.
 */
export async function renamePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  return renamePathBridge(oldPath, newPath);
}

/**
 * Reveal a path in the system file manager.
 */
export async function revealInFileManager(path: string): Promise<void> {
  return revealInFileManagerBridge(path);
}

async function openDialog(
  options: Record<string, unknown>,
): Promise<string | string[] | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    return open(options);
  }

  if (isBrowserLocalRuntime()) {
    return runtimeInvoke<string | null>("open_file_dialog", options);
  }

  return null;
}

async function saveDialog(
  options: Record<string, unknown>,
): Promise<string | null> {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return save(options);
  }

  if (isBrowserLocalRuntime()) {
    return runtimeInvoke<string | null>("save_file_dialog", options);
  }

  return null;
}

/**
 * Open a folder picker dialog and load the selected folder into the file tree.
 */
export async function openFolder(): Promise<string | null> {
  let selected: string | string[] | null = null;

  if (isTauriRuntime()) {
    selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Open Folder",
    });
  } else if (isBrowserLocalRuntime()) {
    selected = await runtimeInvoke<string | null>("open_folder_dialog");
  }

  if (selected && typeof selected === "string") {
    await loadFolder(selected);
    return selected;
  }

  return null;
}

/**
 * Load a folder into the file tree.
 * Also ensures the skills directory and symlink are set up for unified skills support.
 */
export async function loadFolder(path: string): Promise<void> {
  setRootPath(path);

  // Ensure skills symlink is created for Claude Code compatibility
  try {
    await createSkillsSymlink(path);
  } catch (error) {
    console.warn("Failed to create skills symlink:", error);
    // Don't block folder loading if symlink creation fails
  }

  const entries = await listDirectory(path);
  const nodes = entriesToNodes(entries);
  setNodes(nodes);
}

/**
 * Load children for a directory node.
 */
export async function loadDirectoryChildren(path: string): Promise<FileNode[]> {
  const entries = await listDirectory(path);
  return entriesToNodes(entries);
}

/**
 * Convert FileEntry array to FileNode array.
 */
function entriesToNodes(entries: FileEntry[]): FileNode[] {
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    isDirectory: entry.is_directory,
    children: entry.is_directory ? undefined : undefined,
    isExpanded: false,
    isLoading: false,
  }));
}

/**
 * Open a file in a tab.
 */
export async function openFileInTab(path: string): Promise<void> {
  console.log("[openFileInTab] Opening file:", path);
  const content = await readFile(path);
  console.log("[openFileInTab] Read content length:", content.length);
  const tabId = openTab(path, content);
  console.log("[openFileInTab] Opened tab:", tabId);
}

/**
 * Save the content of a tab to disk.
 */
export async function saveTab(
  tabId: string,
  path: string,
  content: string,
): Promise<void> {
  await writeFile(path, content);
  setTabDirty(tabId, false);
}

/**
 * Open a file picker dialog.
 */
export async function openFilePicker(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    title: "Open File",
  });

  if (selected && typeof selected === "string") {
    await openFileInTab(selected);
    return selected;
  }

  return null;
}

/**
 * Open a save file dialog.
 */
export async function saveFileDialog(
  defaultPath?: string,
): Promise<string | null> {
  const selected = await saveDialog({
    defaultPath,
    title: "Save File",
  });

  return selected;
}
