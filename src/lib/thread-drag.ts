// ABOUTME: Shared drag payload helpers for moving threads into workspace panes.
// ABOUTME: Keeps sidebar drag sources and pane drop targets on one MIME schema.

import type { ThreadKind } from "@/stores/thread.store";

export const THREAD_DRAG_MIME = "application/x-seren-thread";
const THREAD_DRAG_TEXT_PREFIX = "seren-thread:";

export interface ThreadDragPayload {
  id: string;
  kind: ThreadKind;
}

let currentThreadDragPayload: ThreadDragPayload | null = null;

export function setCurrentThreadDragPayload(
  payload: ThreadDragPayload | null,
): void {
  currentThreadDragPayload = payload;
}

export function getCurrentThreadDragPayload(): ThreadDragPayload | null {
  return currentThreadDragPayload;
}

export function encodeThreadDragPayload(payload: ThreadDragPayload): string {
  return JSON.stringify(payload);
}

export function encodeThreadDragText(payload: ThreadDragPayload): string {
  return `${THREAD_DRAG_TEXT_PREFIX}${encodeThreadDragPayload(payload)}`;
}

export function decodeThreadDragPayload(
  value: string,
): ThreadDragPayload | null {
  try {
    const json = value.startsWith(THREAD_DRAG_TEXT_PREFIX)
      ? value.slice(THREAD_DRAG_TEXT_PREFIX.length)
      : value;
    const parsed = JSON.parse(json) as Partial<ThreadDragPayload>;
    if (
      typeof parsed.id !== "string" ||
      (parsed.kind !== "chat" &&
        parsed.kind !== "agent" &&
        parsed.kind !== "terminal")
    ) {
      return null;
    }
    return { id: parsed.id, kind: parsed.kind };
  } catch {
    return null;
  }
}
