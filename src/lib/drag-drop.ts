// ABOUTME: SolidJS hook for HTML5 file drag-and-drop attachment.
// ABOUTME: Returns isDragging signal and processes dropped files into Attachment objects.

// We listen on the document for dragover/drop instead of using Tauri's
// onDragDropEvent because the window runs with `dragDropEnabled: false` so
// in-webview HTML5 drag (sidebar thread -> pane bind) works on macOS.
// File drops from Finder still arrive as native HTML5 drops with
// dataTransfer.files populated; we read the blob bytes directly via
// FileReader instead of going through the Tauri filesystem invoke.

import { createSignal, onCleanup } from "solid-js";
import {
  ALL_EXTENSIONS,
  readAttachmentFromBlob,
} from "@/lib/images/attachments";
import type { Attachment } from "@/lib/providers/types";

function getExtension(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

// Counter is shared across hook instances so dragenter/dragleave nesting
// from any pane resolves to one consistent isDragging state across the app.
let dragEnterDepth = 0;
const isDraggingSignal = createSignal(false);
let documentListenersBound = false;
const dropSubscribers = new Set<(files: File[]) => void>();

function dataTransferHasFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  for (const type of transfer.types) {
    if (type === "Files") return true;
  }
  return false;
}

function bindDocumentListeners(): void {
  if (documentListenersBound) return;
  documentListenersBound = true;
  const [, setIsDragging] = isDraggingSignal;

  document.addEventListener("dragenter", (event) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    dragEnterDepth += 1;
    setIsDragging(true);
  });

  document.addEventListener("dragover", (event) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });

  document.addEventListener("dragleave", (event) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    dragEnterDepth = Math.max(0, dragEnterDepth - 1);
    if (dragEnterDepth === 0) setIsDragging(false);
  });

  document.addEventListener("drop", (event) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragEnterDepth = 0;
    setIsDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
      ALL_EXTENSIONS.includes(getExtension(file.name)),
    );
    if (files.length === 0) return;
    for (const subscriber of dropSubscribers) subscriber(files);
  });
}

/**
 * Register a file drop handler scoped to this component's lifetime.
 *
 * @param onFiles Called with successfully read attachments when files are dropped.
 * @returns isDragging signal — true while files are being dragged over the window.
 */
export function createDragDrop(onFiles: (attachments: Attachment[]) => void): {
  isDragging: () => boolean;
} {
  const [isDragging] = isDraggingSignal;

  if (typeof document === "undefined") {
    return { isDragging };
  }

  bindDocumentListeners();

  const subscriber = async (files: File[]) => {
    const attachments: Attachment[] = [];
    for (const file of files) {
      try {
        attachments.push(await readAttachmentFromBlob(file));
      } catch (error) {
        console.warn("[DragDrop] Failed to read file:", file.name, error);
      }
    }
    if (attachments.length > 0) onFiles(attachments);
  };
  dropSubscribers.add(subscriber);
  onCleanup(() => {
    dropSubscribers.delete(subscriber);
  });

  return { isDragging };
}
