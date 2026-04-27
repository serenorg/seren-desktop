// ABOUTME: SolidJS hook for Tauri window-level file drag-and-drop attachment.
// ABOUTME: Returns isDragging signal and processes dropped files into Attachment objects.

import { createSignal, onCleanup } from "solid-js";
import { ALL_EXTENSIONS, readAttachment } from "@/lib/images/attachments";
import type { Attachment } from "@/lib/providers/types";
import { isTauriRuntime } from "@/lib/tauri-bridge";

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

  // The Tauri webview API reads `__TAURI_INTERNALS__.metadata` and throws when
  // it isn't present (browser-fallback / production-bundle e2e / `pnpm browser:local`).
  // Without this gate the throw bubbles to the App ErrorBoundary and unmounts
  // the whole shell — see #1630 follow-up. Drag-and-drop is a Tauri-only
  // capability anyway; the no-op return matches the rest of the runtime.
  if (!isTauriRuntime()) {
    return { isDragging };
  }

  // Imported lazily so the Tauri webview module is not pulled into the
  // browser-fallback graph at module load (where its top-level access can
  // also probe the missing internals).
  const unlistenPromise = import("@tauri-apps/api/webview").then(
    ({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(async (event) => {
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
      }),
  );

  onCleanup(() => {
    void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
  });

  return { isDragging };
}
