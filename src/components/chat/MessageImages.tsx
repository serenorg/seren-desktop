// ABOUTME: Renders image attachments within chat message bubbles.
// ABOUTME: Displays base64 images as thumbnails with click-to-expand behavior.

import type { Component } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { toDataUrl } from "@/lib/images/attachments";
import type { ImageAttachment } from "@/lib/providers/types";

interface MessageImagesProps {
  images: ImageAttachment[];
}

export const MessageImages: Component<MessageImagesProps> = (props) => {
  const [expandedIndex, setExpandedIndex] = createSignal<number | null>(null);

  return (
    <div class="flex flex-wrap gap-2 my-2">
      <For each={props.images}>
        {(image, index) => (
          <>
            <button
              type="button"
              class="border border-[#30363d] rounded-lg overflow-hidden cursor-pointer bg-transparent p-0 hover:border-[#58a6ff] transition-colors"
              onClick={() => setExpandedIndex(index())}
              title={image.name}
            >
              <img
                src={toDataUrl(image)}
                alt={image.name}
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
                  src={toDataUrl(image)}
                  alt={image.name}
                  class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
                />
              </div>
            </Show>
          </>
        )}
      </For>
    </div>
  );
};
