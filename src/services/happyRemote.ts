// ABOUTME: Frontend service for Happy Remote Access bridge lifecycle commands.
// ABOUTME: Keeps all Tauri IPC and status-event wiring behind one typed module.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type HappyRemoteState = "stopped" | "starting" | "running" | "error";

export interface HappyRemoteStatus {
  state: HappyRemoteState;
  detail?: string;
}

const STATUS_EVENT = "happy-bridge://status";

export async function enableRemoteAccess(): Promise<HappyRemoteStatus> {
  return invoke<HappyRemoteStatus>("happy_bridge_enable");
}

export async function disableRemoteAccess(): Promise<HappyRemoteStatus> {
  return invoke<HappyRemoteStatus>("happy_bridge_disable");
}

export async function getRemoteAccessStatus(): Promise<HappyRemoteStatus> {
  return invoke<HappyRemoteStatus>("happy_bridge_status");
}

export function onStatusChange(
  callback: (status: HappyRemoteStatus) => void,
): Promise<UnlistenFn> {
  return listen<HappyRemoteStatus>(STATUS_EVENT, (event) => {
    callback(event.payload);
  });
}
