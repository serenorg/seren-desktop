// ABOUTME: Renders file attachments within chat message bubbles.
// ABOUTME: Displays image thumbnails with click-to-expand, and file icons for non-image types.

import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { isImageMime, toDataUrl } from "@/lib/images/attachments";
import type { Attachment } from "@/lib/providers/types";

interface MessageImagesProps {
  images: Attachment[];
}

export const MessageImages: Component<MessageImagesProps> = (props) => {
  const [expandedIndex, setExpandedIndex] = createSignal<number | null>(null);

  return (
    <div class="flex flex-wrap gap-2 my-2">
      <For each={props.images}>
        {(file, index) => (
          <>
            <Show
              when={isImageMime(file.mimeType)}
              fallback={
                <div
                  class="flex items-center gap-2 px-3 py-2 border border-surface-3 rounded-lg bg-surface-0 text-muted-foreground text-xs"
                  title={file.name}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    role="img"
                    aria-label="File"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span class="max-w-[160px] truncate">{file.name}</span>
                </div>
              }
            >
              <button
                type="button"
                class="border border-surface-3 rounded-lg overflow-hidden cursor-pointer bg-transparent p-0 hover:border-primary transition-colors"
                onClick={() => setExpandedIndex(index())}
                title={file.name}
              >
                <img
                  src={toDataUrl(file)}
                  alt={file.name}
                  class="max-w-[200px] max-h-[150px] object-contain"
                />
              </button>

              {/* Expanded overlay */}
              <Show when={expandedIndex() === index()}>
                <div
                  class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer"
                  onClick={() => setExpandedIndex(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setExpandedIndex(null);
                  }}
                >
                  <img
                    src={toDataUrl(file)}
                    alt={file.name}
                    class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
                  />
                </div>
              </Show>
            </Show>
          </>
        )}
      </For>
    </div>
  );
};
