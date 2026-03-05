// ABOUTME: SolidJS hook for Tauri window-level file drag-and-drop attachment.
// ABOUTME: Returns isDragging signal and processes dropped files into Attachment objects.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { createSignal, onCleanup } from "solid-js";
import { ALL_EXTENSIONS, readAttachment } from "@/lib/images/attachments";
import type { Attachment } from "@/lib/providers/types";

function getExtension(path: string): string {
  const parts = path.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

/**
 * Register a Tauri drag-and-drop handler for the current webview.
 * Call inside a SolidJS component — cleans up the listener automatically.
 *
 * @param onFiles Called with successfully read attachments when files are dropped.
 * @returns isDragging signal — true while files are being dragged over the window.
 */
export function createDragDrop(onFiles: (attachments: Attachment[]) => void): {
  isDragging: () => boolean;
} {
  const [isDragging, setIsDragging] = createSignal(false);

  const unlistenPromise = getCurrentWebview().onDragDropEvent(async (event) => {
    const { type } = event.payload;

    if (type === "enter") {
      setIsDragging(true);
    } else if (type === "leave") {
      setIsDragging(false);
    } else if (type === "drop") {
      setIsDragging(false);
      const paths = event.payload.paths.filter((p) =>
        ALL_EXTENSIONS.includes(getExtension(p)),
      );
      if (paths.length === 0) return;

      const attachments: Attachment[] = [];
      for (const path of paths) {
        try {
          attachments.push(await readAttachment(path));
        } catch (error) {
          console.warn("[DragDrop] Failed to read file:", path, error);
        }
      }
      if (attachments.length > 0) {
        onFiles(attachments);
      }
    }
  });

  onCleanup(() => {
    unlistenPromise.then((unlisten) => unlisten());
  });

  return { isDragging };
}
