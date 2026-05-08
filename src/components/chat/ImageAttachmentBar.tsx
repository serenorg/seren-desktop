// ABOUTME: Composer attachment bar for chat and agent inputs.
// ABOUTME: Shows attach button, file thumbnails, and active thread skill chips.

import {
  type Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { SkillAttachmentChips } from "@/components/chat/SkillAttachmentChips";
import { isImageMime, toDataUrl } from "@/lib/images/attachments";
import type { Attachment } from "@/lib/providers/types";

interface ImageAttachmentBarProps {
  images: Attachment[];
  onAttach: () => void;
  onRemove: (index: number) => void;
  isLoading?: boolean;
  projectRoot?: string | null;
  threadId?: string | null;
}

export const ImageAttachmentBar: Component<ImageAttachmentBarProps> = (
  props,
) => {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menuRef: HTMLDivElement | undefined;

  const canAttachSkill = () => Boolean(props.projectRoot && props.threadId);

  const openSkillsPanel = () => {
    setMenuOpen(false);
    window.dispatchEvent(
      new CustomEvent("seren:open-panel", { detail: "skills" }),
    );
  };

  createEffect(() => {
    if (!menuOpen()) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  return (
    <div class="flex items-center gap-2 flex-wrap">
      <div class="relative" ref={(el) => (menuRef = el)}>
        <button
          type="button"
          class={`flex items-center gap-1 px-2 py-1 bg-transparent border border-surface-3 text-muted-foreground rounded text-xs cursor-pointer transition-colors hover:bg-surface-2 hover:text-foreground ${props.isLoading ? "opacity-50 cursor-wait" : ""}`}
          onClick={() => {
            if (!props.isLoading) {
              setMenuOpen((open) => !open);
            }
          }}
          disabled={props.isLoading}
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          title={props.isLoading ? "Opening..." : "Attach file or skill"}
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
              role="img"
              aria-label="Attach"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </Show>
          {props.isLoading ? "Opening..." : "Attach"}
        </button>

        <Show when={menuOpen()}>
          <div class="absolute left-0 bottom-full z-50 mb-2 min-w-[150px] overflow-hidden rounded-lg border border-border bg-surface-1 shadow-xl py-1">
            <button
              type="button"
              class="flex w-full items-center gap-2 bg-transparent border-none px-3 py-2 text-left text-[12px] text-foreground cursor-pointer hover:bg-surface-2"
              onClick={() => {
                setMenuOpen(false);
                props.onAttach();
              }}
            >
              File
            </button>
            <button
              type="button"
              class="flex w-full items-center gap-2 bg-transparent border-none px-3 py-2 text-left text-[12px] text-foreground cursor-pointer hover:bg-surface-2 disabled:opacity-50 disabled:cursor-default"
              onClick={openSkillsPanel}
              disabled={!canAttachSkill()}
              title={
                canAttachSkill()
                  ? "Attach a skill to this thread"
                  : "Select a thread first"
              }
            >
              Skill
            </button>
          </div>
        </Show>
      </div>

      <SkillAttachmentChips
        projectRoot={props.projectRoot ?? null}
        threadId={props.threadId ?? null}
      />

      <Show when={props.images.length > 0}>
        <div class="flex items-center gap-1.5 overflow-x-auto">
          <For each={props.images}>
            {(file, index) => (
              <div
                class="relative group flex-shrink-0"
                title={`${file.name} - this message only`}
              >
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
                  {"x"}
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
