// ABOUTME: Image viewer component for displaying image files.
// ABOUTME: Supports zoom, pan, and displays image metadata.

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";

interface ImageViewerProps {
  filePath: string;
}

export const ImageViewer: Component<ImageViewerProps> = (props) => {
  const [zoom, setZoom] = createSignal(100);
  const [imageUrl, setImageUrl] = createSignal<string | null>(null);
  const [dimensions, setDimensions] = createSignal<{
    width: number;
    height: number;
  } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);
  const [position, setPosition] = createSignal({ x: 0, y: 0 });
  const [dragStart, setDragStart] = createSignal({ x: 0, y: 0 });

  // Load image when file path changes
  createEffect(() => {
    const path = props.filePath;
    if (!path) return;

    // Convert file path to URL using Tauri's asset protocol
    const url = convertFileSrc(path);
    setImageUrl(url);
    setError(null);
    setZoom(100);
    setPosition({ x: 0, y: 0 });
  });

  function handleImageLoad(e: Event) {
    const img = e.target as HTMLImageElement;
    setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
  }

  function handleImageError() {
    setError("Failed to load image");
  }

  function handleZoomIn() {
    setZoom((z) => Math.min(z + 25, 400));
  }

  function handleZoomOut() {
    setZoom((z) => Math.max(z - 25, 25));
  }

  function handleZoomReset() {
    setZoom(100);
    setPosition({ x: 0, y: 0 });
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.deltaY < 0) {
      handleZoomIn();
    } else {
      handleZoomOut();
    }
  }

  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - position().x, y: e.clientY - position().y });
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isDragging()) return;
    setPosition({
      x: e.clientX - dragStart().x,
      y: e.clientY - dragStart().y,
    });
  }

  function handleMouseUp() {
    setIsDragging(false);
  }

  // Add global mouse event listeners for drag
  createEffect(() => {
    if (isDragging()) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }
    onCleanup(() => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    });
  });

  const fileName = () => {
    const parts = props.filePath.split("/");
    return parts[parts.length - 1];
  };

  return (
    <div class="flex flex-col h-full bg-card">
      <div class="flex items-center justify-between px-4 py-2 bg-popover border-b border-[rgba(148,163,184,0.15)] shrink-0">
        <div class="flex items-center gap-4">
          <span class="font-medium text-foreground">{fileName()}</span>
          {dimensions() && (
            <span class="text-xs text-muted-foreground">
              {dimensions()?.width} × {dimensions()?.height}
            </span>
          )}
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="bg-transparent border border-[rgba(148,163,184,0.25)] text-foreground w-8 h-8 rounded flex items-center justify-center text-lg cursor-pointer transition-all hover:bg-[rgba(148,163,184,0.15)] hover:border-[rgba(148,163,184,0.4)]"
            onClick={handleZoomOut}
            title="Zoom Out"
          >
            −
          </button>
          <span class="min-w-[50px] text-center text-[13px] text-muted-foreground">
            {zoom()}%
          </span>
          <button
            type="button"
            class="bg-transparent border border-[rgba(148,163,184,0.25)] text-foreground w-8 h-8 rounded flex items-center justify-center text-lg cursor-pointer transition-all hover:bg-[rgba(148,163,184,0.15)] hover:border-[rgba(148,163,184,0.4)]"
            onClick={handleZoomIn}
            title="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            class="bg-transparent border border-[rgba(148,163,184,0.25)] text-foreground w-8 h-8 rounded flex items-center justify-center text-lg cursor-pointer transition-all hover:bg-[rgba(148,163,184,0.15)] hover:border-[rgba(148,163,184,0.4)]"
            onClick={handleZoomReset}
            title="Reset Zoom"
          >
            ⟳
          </button>
        </div>
      </div>

      <div
        class={`flex-1 overflow-hidden flex items-center justify-center relative cursor-grab ${isDragging() ? "cursor-grabbing" : ""} before:content-[''] before:absolute before:inset-0 before:bg-[linear-gradient(45deg,#2a2a2a_25%,transparent_25%),linear-gradient(-45deg,#2a2a2a_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#2a2a2a_75%),linear-gradient(-45deg,transparent_75%,#2a2a2a_75%)] before:bg-[length:20px_20px] before:bg-[position:0_0,0_10px,10px_-10px,-10px_0px] before:opacity-50 before:z-0`}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
      >
        {error() ? (
          <div class="text-destructive text-sm">{error()}</div>
        ) : (
          <Show
            when={imageUrl()}
            fallback={
              <div class="text-muted-foreground text-sm">Loading...</div>
            }
          >
            {(url) => (
              <img
                src={url()}
                alt={fileName()}
                class={`max-w-none max-h-none origin-center select-none relative z-[1] ${isDragging() ? "" : "transition-transform duration-100 ease-out"}`}
                style={{
                  transform: `translate(${position().x}px, ${position().y}px) scale(${zoom() / 100})`,
                }}
                onLoad={handleImageLoad}
                onError={handleImageError}
                draggable={false}
              />
            )}
          </Show>
        )}
      </div>
    </div>
  );
};

export default ImageViewer;
