// ABOUTME: Resizable textarea component with a visible drag handle at the top.
// ABOUTME: Provides better UX than native resize-y for chat/agent input boxes.

import type { Component, JSX } from "solid-js";
import { createSignal, onCleanup, onMount } from "solid-js";

interface ResizableTextareaProps {
  ref?: (el: HTMLTextAreaElement) => void;
  value: string;
  placeholder?: string;
  class?: string;
  onInput?: JSX.EventHandler<HTMLTextAreaElement, InputEvent>;
  onKeyDown?: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent>;
  disabled?: boolean;
  minHeight?: number;
  maxHeight?: number;
}

export const ResizableTextarea: Component<ResizableTextareaProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  const [height, setHeight] = createSignal(props.minHeight ?? 80);
  const [isDragging, setIsDragging] = createSignal(false);
  const [isHovering, setIsHovering] = createSignal(false);

  const minHeight = props.minHeight ?? 80;
  const maxHeight = props.maxHeight ?? window.innerHeight * 0.5;

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging() || !containerRef) return;

    const containerRect = containerRef.getBoundingClientRect();
    // Calculate new height based on mouse position relative to container bottom
    // Dragging UP (lower Y) = bigger textarea
    const newHeight = containerRect.bottom - e.clientY;
    const clampedHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
    setHeight(clampedHeight);
  };

  const handleMouseUp = () => {
    if (isDragging()) {
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  };

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  });

  onCleanup(() => {
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  });

  // Determine handle visibility and color based on state
  const handleActive = () => isDragging() || isHovering();
  const handleColor = () => {
    if (isDragging()) return "#58a6ff";
    if (isHovering()) return "#8b949e";
    return "#484f58";
  };

  return (
    <div ref={containerRef} class="relative">
      {/* Resize handle at top - larger clickable area with visible grip */}
      <div
        class="absolute top-0 left-0 right-0 h-4 cursor-ns-resize flex items-center justify-center z-10 -translate-y-2"
        onMouseDown={handleMouseDown}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        title="Drag to resize"
      >
        {/* Chevron up icon with grip dots */}
        <div
          class="flex flex-col items-center gap-px transition-opacity duration-150"
          style={{ opacity: handleActive() ? 1 : 0.6 }}
        >
          {/* Up/down chevron arrows */}
          <svg
            width="16"
            height="10"
            viewBox="0 0 16 10"
            fill="none"
            style={{ color: handleColor() }}
            aria-hidden="true"
          >
            <path
              d="M4 6L8 2L12 6"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M4 4L8 8L12 4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              opacity="0.5"
            />
          </svg>
          {/* Grip bar */}
          <div
            class="w-8 h-0.5 rounded-full transition-colors duration-150"
            style={{ "background-color": handleColor() }}
          />
        </div>
      </div>
      <textarea
        ref={(el) => {
          props.ref?.(el);
        }}
        value={props.value}
        placeholder={props.placeholder}
        class={props.class}
        style={{ height: `${height()}px`, resize: "none" }}
        onInput={props.onInput}
        onKeyDown={props.onKeyDown}
        disabled={props.disabled}
      />
    </div>
  );
};
