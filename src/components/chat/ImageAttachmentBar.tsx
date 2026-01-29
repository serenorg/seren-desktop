// ABOUTME: Shared image attachment UI for chat and agent input areas.
// ABOUTME: Shows attach button, image thumbnails, and remove controls.

import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { toDataUrl } from "@/lib/images/attachments";
import type { ImageAttachment } from "@/lib/providers/types";

interface ImageAttachmentBarProps {
  images: ImageAttachment[];
  onAttach: () => void;
  onRemove: (index: number) => void;
}

export const ImageAttachmentBar: Component<ImageAttachmentBarProps> = (
  props,
) => {
  return (
    <div class="flex items-center gap-2">
      {/* Attach button */}
      <button
        type="button"
        class="flex items-center gap-1 px-2 py-1 bg-transparent border border-[#30363d] text-[#8b949e] rounded text-xs cursor-pointer transition-colors hover:bg-[#21262d] hover:text-[#e6edf3]"
        onClick={props.onAttach}
        title="Attach images"
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
        Attach
      </button>

      {/* Image thumbnails */}
      <Show when={props.images.length > 0}>
        <div class="flex items-center gap-1.5 overflow-x-auto">
          <For each={props.images}>
            {(image, index) => (
              <div class="relative group flex-shrink-0">
                <img
                  src={toDataUrl(image)}
                  alt={image.name}
                  class="w-10 h-10 object-cover rounded border border-[#30363d]"
                />
                <button
                  type="button"
                  class="absolute -top-1 -right-1 w-4 h-4 bg-[#f85149] text-white rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer border-none"
                  onClick={() => props.onRemove(index())}
                  title={`Remove ${image.name}`}
                >
                  ×
                </button>
                <div class="absolute bottom-0 left-0 right-0 bg-black/60 text-[8px] text-white text-center truncate px-0.5 rounded-b">
                  {image.name}
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
