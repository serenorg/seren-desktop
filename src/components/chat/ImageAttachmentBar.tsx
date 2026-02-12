// ABOUTME: Shared file attachment UI for chat and agent input areas.
// ABOUTME: Shows attach button, thumbnails for images, and file icons for other types.

import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { isImageMime, toDataUrl } from "@/lib/images/attachments";
import type { Attachment } from "@/lib/providers/types";

interface ImageAttachmentBarProps {
  images: Attachment[];
  onAttach: () => void;
  onRemove: (index: number) => void;
  isLoading?: boolean;
}

export const ImageAttachmentBar: Component<ImageAttachmentBarProps> = (
  props,
) => {
  // Debug logging to trace rendering
  console.log(
    "[ImageAttachmentBar] Rendering with",
    props.images.length,
    "images, isLoading:",
    props.isLoading,
  );

  return (
    <div class="flex items-center gap-2">
      {/* Attach button */}
      <button
        type="button"
        class={`flex items-center gap-1 px-2 py-1 bg-transparent border border-surface-3 text-muted-foreground rounded text-xs cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground ${props.isLoading ? "opacity-50 cursor-wait" : ""}`}
        onClick={() => {
          console.log(
            "[ImageAttachmentBar] Attach button clicked, isLoading:",
            props.isLoading,
          );
          if (!props.isLoading) {
            props.onAttach();
          }
        }}
        disabled={props.isLoading}
        title={props.isLoading ? "Opening file picker..." : "Attach files"}
      >
        <Show
          when={!props.isLoading}
          fallback={
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="animate-spin"
              role="img"
              aria-label="Loading"
            >
              <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" />
            </svg>
          }
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
            aria-label="Attach"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </Show>
        {props.isLoading ? "Opening..." : "Attach"}
      </button>

      {/* Attachment thumbnails */}
      <Show when={props.images.length > 0}>
        <div class="flex items-center gap-1.5 overflow-x-auto">
          <For each={props.images}>
            {(file, index) => (
              <div class="relative group flex-shrink-0">
                <Show
                  when={isImageMime(file.mimeType)}
                  fallback={
                    <div class="w-10 h-10 flex items-center justify-center rounded border border-surface-3 bg-surface-2 text-muted-foreground">
                      <svg
                        width="16"
                        height="16"
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
                    </div>
                  }
                >
                  <img
                    src={toDataUrl(file)}
                    alt={file.name}
                    class="w-10 h-10 object-cover rounded border border-surface-3"
                  />
                </Show>
                <button
                  type="button"
                  class="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-white rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer border-none"
                  onClick={() => props.onRemove(index())}
                  title={`Remove ${file.name}`}
                >
                  ×
                </button>
                <div class="absolute bottom-0 left-0 right-0 bg-black/60 text-[8px] text-white text-center truncate px-0.5 rounded-b">
                  {file.name}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
