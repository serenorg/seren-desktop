// ABOUTME: Three-column resizable layout with draggable separators.
// ABOUTME: Provides Cursor-style layout: FileTree | Editor | Chat.

import { createSignal, onCleanup, onMount, Show, type ParentComponent } from "solid-js";

export interface ResizableLayoutProps {
  /** Initial width of the left panel in pixels */
  leftWidth?: number;
  /** Initial width of the right panel in pixels */
  rightWidth?: number;
  /** Minimum width of the left panel */
  leftMinWidth?: number;
  /** Maximum width of the left panel */
  leftMaxWidth?: number;
  /** Minimum width of the right panel */
  rightMinWidth?: number;
  /** Maximum width of the right panel */
  rightMaxWidth?: number;
  /** Content for the left panel (FileTree) */
  left: import("solid-js").JSX.Element;
  /** Content for the center panel (Editor) */
  center: import("solid-js").JSX.Element;
  /** Content for the right panel (Chat) */
  right: import("solid-js").JSX.Element;
}

const STORAGE_KEY = "resizable-layout-widths";

interface StoredWidths {
  left: number;
  right: number;
}

function loadStoredWidths(): StoredWidths | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as StoredWidths;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function saveWidths(widths: StoredWidths): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Ignore storage errors
  }
}

export const ResizableLayout: ParentComponent<ResizableLayoutProps> = (props) => {
  const stored = loadStoredWidths();
  const [leftWidth, setLeftWidth] = createSignal(stored?.left ?? props.leftWidth ?? 240);
  const [rightWidth, setRightWidth] = createSignal(stored?.right ?? props.rightWidth ?? 400);
  const [isDraggingLeft, setIsDraggingLeft] = createSignal(false);
  const [isDraggingRight, setIsDraggingRight] = createSignal(false);

  const leftMinWidth = props.leftMinWidth ?? 180;
  const leftMaxWidth = props.leftMaxWidth ?? 500;
  const rightMinWidth = props.rightMinWidth ?? 280;
  const rightMaxWidth = props.rightMaxWidth ?? 800;

  let containerRef: HTMLDivElement | undefined;

  const handleMouseMove = (e: MouseEvent) => {
    if (!containerRef) return;

    const rect = containerRef.getBoundingClientRect();

    if (isDraggingLeft()) {
      const newWidth = e.clientX - rect.left;
      const clamped = Math.max(leftMinWidth, Math.min(leftMaxWidth, newWidth));
      setLeftWidth(clamped);
    }

    if (isDraggingRight()) {
      const newWidth = rect.right - e.clientX;
      const clamped = Math.max(rightMinWidth, Math.min(rightMaxWidth, newWidth));
      setRightWidth(clamped);
    }
  };

  const handleMouseUp = () => {
    if (isDraggingLeft() || isDraggingRight()) {
      // Save widths when drag ends
      saveWidths({ left: leftWidth(), right: rightWidth() });
    }
    setIsDraggingLeft(false);
    setIsDraggingRight(false);
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
    <div
      ref={containerRef}
      class="resizable-layout"
      classList={{
        "resizable-layout--dragging": isDraggingLeft() || isDraggingRight(),
      }}
    >
      {/* Left Panel (FileTree) */}
      <div
        class="resizable-layout__left"
        style={{ width: `${leftWidth()}px` }}
      >
        {props.left}
      </div>

      {/* Left Separator */}
      <div
        class="resizable-layout__separator"
        classList={{ "resizable-layout__separator--active": isDraggingLeft() }}
        onMouseDown={(e) => {
          e.preventDefault();
          setIsDraggingLeft(true);
        }}
      />

      {/* Center Panel (Chat) */}
      <div class="resizable-layout__center">
        {props.center}
      </div>

      <Show when={props.right}>
        {/* Right Separator */}
        <div
          class="resizable-layout__separator"
          classList={{ "resizable-layout__separator--active": isDraggingRight() }}
          onMouseDown={(e) => {
            e.preventDefault();
            setIsDraggingRight(true);
          }}
        />

        {/* Right Panel (Editor) */}
        <div
          class="resizable-layout__right"
          style={{ width: `${rightWidth()}px` }}
        >
          {props.right}
        </div>
      </Show>
    </div>
  );
};
