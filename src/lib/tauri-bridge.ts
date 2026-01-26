// ABOUTME: Frontend wrapper for Tauri IPC commands.
// ABOUTME: Provides typed functions for secure token storage and Rust communication.

import { invoke } from "@tauri-apps/api/core";

/**
 * Store authentication token securely using OS keychain.
 */
export async function storeToken(token: string): Promise<void> {
  await invoke("store_token", { token });
}

/**
 * Retrieve stored authentication token.
 * Returns null if no token is stored.
 */
export async function getToken(): Promise<string | null> {
  return await invoke<string | null>("get_token");
}

/**
 * Clear stored authentication token (logout).
 */
export async function clearToken(): Promise<void> {
  await invoke("clear_token");
}

// ============================================================================
// File System Operations
// ============================================================================

/**
 * File entry from directory listing.
 */
export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

/**
 * List entries in a directory.
 * Returns files and folders sorted with directories first.
 */
export async function listDirectory(path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("list_directory", { path });
}

/**
 * Read the contents of a file.
 */
export async function readFile(path: string): Promise<string> {
  return await invoke<string>("read_file", { path });
}

/**
 * Write content to a file.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  await invoke("write_file", { path, content });
}

/**
 * Check if a path exists.
 */
export async function pathExists(path: string): Promise<boolean> {
  return await invoke<boolean>("path_exists", { path });
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  return await invoke<boolean>("is_directory", { path });
}

/**
 * Create a new file with optional content.
 */
export async function createFile(path: string, content?: string): Promise<void> {
  await invoke("create_file", { path, content });
}

/**
 * Create a new directory.
 */
export async function createDirectory(path: string): Promise<void> {
  await invoke("create_directory", { path });
}

/**
 * Delete a file or empty directory.
 */
export async function deletePath(path: string): Promise<void> {
  await invoke("delete_path", { path });
}

/**
 * Rename/move a file or directory.
 */
export async function renamePath(oldPath: string, newPath: string): Promise<void> {
  await invoke("rename_path", { oldPath, newPath });
}
