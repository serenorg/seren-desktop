// ABOUTME: Right slide-out panel for editor, settings, and database views.
// ABOUTME: Slides in from the right with animation, shares space with main content.

import { type Component, type JSX, Show } from "solid-js";

interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  children: JSX.Element;
}

export const SlidePanel: Component<SlidePanelProps> = (props) => {
  return (
    <Show when={props.open}>
      <div class="absolute inset-0 z-[15] flex justify-end">
        <div
          class="absolute inset-0 bg-black/30 animate-[fadeIn_200ms_ease]"
          onClick={props.onClose}
        />
        <div
          class="relative w-[var(--slide-panel-width)] max-w-[90vw] h-full bg-surface-1 border-l border-border shadow-[var(--shadow-lg)] overflow-x-hidden overflow-y-auto animate-[slideInRight_200ms_ease]"
          classList={{ "w-[720px]": props.wide }}
        >
          <button
            class="absolute top-3 right-3 w-7 h-7 flex items-center justify-center bg-transparent border-none rounded-md text-muted-foreground cursor-pointer z-[1] transition-all duration-100 hover:bg-surface-2 hover:text-foreground"
            onClick={props.onClose}
            title="Close panel"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Close"
            >
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
          {props.children}
        </div>
      </div>
    </Show>
  );
};
