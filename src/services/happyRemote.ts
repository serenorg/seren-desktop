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
const PAIRING_EVENT = "happy-bridge://pairing";

export async function enableRemoteAccess(): Promise<HappyRemoteStatus> {
  return invoke<HappyRemoteStatus>("happy_bridge_enable");
}

export async function disableRemoteAccess(): Promise<HappyRemoteStatus> {
  return invoke<HappyRemoteStatus>("happy_bridge_disable");
}

export async function getRemoteAccessStatus(): Promise<HappyRemoteStatus> {
  return invoke<HappyRemoteStatus>("happy_bridge_status");
}

export async function getAdvertisedRoots(): Promise<string[] | null> {
  return invoke<string[] | null>("happy_bridge_get_advertised_roots");
}

export async function updateAdvertisedRoots(
  roots: string[],
): Promise<HappyRemoteStatus> {
  return invoke<HappyRemoteStatus>("happy_bridge_update_roots", { roots });
}

export async function resetRemoteIdentity(): Promise<void> {
  return invoke<void>("happy_bridge_reset_identity");
}

export async function startPairing(): Promise<string> {
  return invoke<string>("happy_bridge_start_pairing");
}

export function onStatusChange(
  callback: (status: HappyRemoteStatus) => void,
): Promise<UnlistenFn> {
  return listen<HappyRemoteStatus>(STATUS_EVENT, (event) => {
    callback(event.payload);
  });
}

export function onPairing(
  callback: (payload: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(PAIRING_EVENT, (event) => {
    callback(event.payload);
  });
}
