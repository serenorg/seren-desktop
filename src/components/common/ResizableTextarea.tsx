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

  return (
    <div ref={containerRef} class="relative">
      {/* Resize handle at top */}
      <div
        class="absolute top-0 left-0 right-0 h-2 cursor-ns-resize flex items-center justify-center group z-10 -translate-y-1"
        onMouseDown={handleMouseDown}
      >
        <div
          class={`w-12 h-1 rounded-full transition-colors ${
            isDragging()
              ? "bg-[#58a6ff]"
              : "bg-[#30363d] group-hover:bg-[#484f58]"
          }`}
        />
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
