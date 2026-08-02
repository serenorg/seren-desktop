// ABOUTME: Frontend wrapper for the macOS folder-access (TCC) permission commands.
// ABOUTME: Lets the settings UI check/request Desktop/Documents/Downloads access so agents can use working roots there.

import { invoke } from "@tauri-apps/api/core";

/** The macOS special user folders macOS gates individually via TCC. */
export type FolderAccessKey = "desktop" | "documents" | "downloads";

export type FolderAccessStatus = "granted" | "denied" | "unsupported";

export interface FolderAccessCheck {
  key: FolderAccessKey;
  status: FolderAccessStatus;
  label: string;
  path: string;
  message: string;
  canRequest: boolean;
}

export interface FolderAccessPreflight {
  platform: string;
  checks: FolderAccessCheck[];
}

/** Report access status for every macOS special folder. */
export async function checkFolderAccessPermissions(): Promise<FolderAccessPreflight> {
  return invoke<FolderAccessPreflight>("folder_access_check_permissions");
}

/**
 * Surface the macOS consent prompt for one folder by touching it from the
 * foreground app, then return the refreshed preflight.
 */
export async function requestFolderAccessPermission(
  key: FolderAccessKey,
): Promise<FolderAccessPreflight> {
  return invoke<FolderAccessPreflight>("folder_access_request_permission", {
    key,
  });
}

/** Deep-link to System Settings → Privacy & Security → Files and Folders. */
export async function openFolderAccessSettings(): Promise<void> {
  await invoke("folder_access_open_permission_settings");
}
