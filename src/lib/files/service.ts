// ABOUTME: File-system service layer for editor tabs and project file trees.
// ABOUTME: Routes file operations through the Tauri/browser-local bridge.

import {
  isBrowserLocalRuntime,
  runtimeInvoke,
} from "@/lib/browser-local-runtime";
import { isPdfFile } from "@/lib/files/file-types";
import { imageMimeType, isSupportedImageFile } from "@/lib/images/file-types";
import { createSkillsSymlink } from "@/lib/skills/paths";
import {
  createDirectory as createDirectoryBridge,
  createFile as createFileBridge,
  deletePath as deletePathBridge,
  isDirectory as isDirectoryBridge,
  isTauriRuntime,
  listDirectory as listDirectoryBridge,
  openPathWithDefaultApp as openPathWithDefaultAppBridge,
  pathExists as pathExistsBridge,
  readFileBase64 as readFileBase64Bridge,
  readFile as readFileBridge,
  renamePath as renamePathBridge,
  revealInFileManager as revealInFileManagerBridge,
  writeFile as writeFileBridge,
} from "@/lib/tauri-bridge";
import { type FileNode, setNodes, setRootPath } from "@/stores/fileTree";
import {
  openTab,
  setTabDirty,
  setTabSavedContent,
  tabsState,
} from "@/stores/tabs";

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

/**
 * Open an image file with the operating system's default image viewer.
 */
export async function openImageInDefaultViewer(path: string): Promise<void> {
  return openPathWithDefaultAppBridge(path);
}

/**
 * Read an image file as a `data:` URL for in-app preview. Reads the bytes via
 * the base64 bridge (which resolves `~` and reads binary safely on every
 * platform) so the viewer never depends on asset-protocol path resolution.
 */
export async function readImageAsDataUrl(path: string): Promise<string> {
  const base64 = await readFileBase64Bridge(path);
  const mime = imageMimeType(path) ?? "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

/**
 * Read a file as raw bytes for binary viewers. Goes through the base64 bridge
 * (which resolves `~` and reads binary safely on every platform) and decodes
 * client-side, so the viewer never depends on `file://`/asset path formats.
 */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const base64 = await readFileBase64Bridge(path);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

const HASH_ANCHOR = /^(.+?)#L(\d+)(?:-L?\d+)?$/;
const COLON_ANCHOR = /^(.+?):(\d+)(?::\d+)?$/;

function matchAnchor(rawPath: string): RegExpMatchArray | null {
  return rawPath.match(HASH_ANCHOR) ?? rawPath.match(COLON_ANCHOR);
}

/**
 * Strip a trailing line/column anchor from an agent-generated file link.
 * Handles `#L42`, `#L10-L20`, `:42`, and `:42:5`. Returns the input unchanged
 * if no anchor is present (including Windows paths like `C:\foo\bar.md`).
 */
export function stripLineAnchor(rawPath: string): string {
  const match = matchAnchor(rawPath);
  return match ? match[1] : rawPath;
}

/**
 * Extract the line number from an agent-generated file link, or undefined
 * if no anchor is present.
 */
export function extractLineAnchor(rawPath: string): number | undefined {
  const match = matchAnchor(rawPath);
  return match ? Number.parseInt(match[2], 10) : undefined;
}

/**
 * Resolve a default cwd for a file when the caller has not supplied one.
 * Falls back to the file's parent directory so every tab still belongs to
 * some session.
 */
function fileDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

export interface OpenFileOptions {
  /** Session root the tab joins. Defaults to the file's parent directory. */
  cwd?: string;
}

/**
 * Open a file in a tab.
 */
export async function openFileInTab(
  rawPath: string,
  options: OpenFileOptions = {},
): Promise<void> {
  // Strip line/column anchors before reading. Agents emit two styles:
  // markdown anchors (#L79, #L10-L20) and grep/editor refs
  // (path:line, path:line:col). Both must be removed before readFile.
  // Non-greedy + end-anchor preserves Windows drive letters like C:\foo.md.
  const path = stripLineAnchor(rawPath);
  const cwd = (options.cwd ?? fileDirname(path)).replace(/\/+$/, "") || "/";
  // Image and PDF files are rendered by dedicated viewers that load their
  // bytes themselves. They are binary, so reading them as UTF-8 text here
  // throws and the tab would never open — clicking the link would silently
  // do nothing.
  if (isSupportedImageFile(path) || isPdfFile(path)) {
    openTab(path, "", cwd);
    return;
  }
  const content = await readFile(path);
  openTab(path, content, cwd);
}

/**
 * Save the content of a tab to disk.
 */
export async function saveTab(
  tabId: string,
  path: string,
  content: string,
): Promise<boolean> {
  await writeFile(path, content);
  const currentTab = tabsState.tabs.find((tab) => tab.id === tabId);
  const savedCurrentContent = currentTab?.content === content;
  if (savedCurrentContent) {
    setTabSavedContent(tabId, content);
    setTabDirty(tabId, false);
  }
  return savedCurrentContent;
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
