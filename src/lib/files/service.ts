import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
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
  return invoke<string>("read_file", { path });
}

/**
 * Write content to a file.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

/**
 * List entries in a directory.
 */
export async function listDirectory(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_directory", { path });
}

/**
 * Check if a path exists.
 */
export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  return invoke<boolean>("is_directory", { path });
}

/**
 * Create a new file with optional content.
 */
export async function createFile(
  path: string,
  content?: string,
): Promise<void> {
  return invoke("create_file", { path, content });
}

/**
 * Create a new directory.
 */
export async function createDirectory(path: string): Promise<void> {
  return invoke("create_directory", { path });
}

/**
 * Delete a file or empty directory.
 */
export async function deletePath(path: string): Promise<void> {
  return invoke("delete_path", { path });
}

/**
 * Rename/move a file or directory.
 */
export async function renamePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke("rename_path", { oldPath, newPath });
}

/**
 * Open a folder picker dialog and load the selected folder into the file tree.
 */
export async function openFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Folder",
  });

  if (selected && typeof selected === "string") {
    await loadFolder(selected);
    return selected;
  }

  return null;
}

/**
 * Load a folder into the file tree.
 */
export async function loadFolder(path: string): Promise<void> {
  setRootPath(path);
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
  const content = await readFile(path);
  openTab(path, content);
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
  const selected = await open({
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
  const selected = await save({
    defaultPath,
    title: "Save File",
  });

  return selected;
}
