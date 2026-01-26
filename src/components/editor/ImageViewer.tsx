// ABOUTME: Image viewer component for displaying image files.
// ABOUTME: Supports zoom, pan, and displays image metadata.

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import "./ImageViewer.css";

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
    <div class="image-viewer">
      <div class="image-viewer-toolbar">
        <div class="image-viewer-info">
          <span class="image-viewer-filename">{fileName()}</span>
          {dimensions() && (
            <span class="image-viewer-dimensions">
              {dimensions()?.width} × {dimensions()?.height}
            </span>
          )}
        </div>
        <div class="image-viewer-controls">
          <button
            type="button"
            class="image-viewer-btn"
            onClick={handleZoomOut}
            title="Zoom Out"
          >
            −
          </button>
          <span class="image-viewer-zoom">{zoom()}%</span>
          <button
            type="button"
            class="image-viewer-btn"
            onClick={handleZoomIn}
            title="Zoom In"
          >
            +
          </button>
          <button
            type="button"
            class="image-viewer-btn"
            onClick={handleZoomReset}
            title="Reset Zoom"
          >
            ⟳
          </button>
        </div>
      </div>

      <div
        class="image-viewer-container"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        classList={{ dragging: isDragging() }}
      >
        {error() ? (
          <div class="image-viewer-error">{error()}</div>
        ) : imageUrl() ? (
          <img
            src={imageUrl()!}
            alt={fileName()}
            class="image-viewer-image"
            style={{
              transform: `translate(${position().x}px, ${position().y}px) scale(${zoom() / 100})`,
            }}
            onLoad={handleImageLoad}
            onError={handleImageError}
            draggable={false}
          />
        ) : (
          <div class="image-viewer-loading">Loading...</div>
        )}
      </div>
    </div>
  );
};

export default ImageViewer;
