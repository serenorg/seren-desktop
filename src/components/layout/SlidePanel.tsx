// ABOUTME: Right slide-out panel for editor, settings, and database views.
// ABOUTME: Slides in from the right with animation, shares space with main content.

import { type Component, type JSX, Show } from "solid-js";
import "./SlidePanel.css";

interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  children: JSX.Element;
}

export const SlidePanel: Component<SlidePanelProps> = (props) => {
  return (
    <Show when={props.open}>
      <div class="slide-panel">
        <div class="slide-panel__backdrop" onClick={props.onClose} />
        <div
          class="slide-panel__content"
          classList={{ "slide-panel__content--wide": props.wide }}
        >
          <button
            class="slide-panel__close"
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
