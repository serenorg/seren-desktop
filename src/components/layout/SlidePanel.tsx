// ABOUTME: Right slide-out panel for editor, settings, and database views.
// ABOUTME: Slides in from the right with animation, shares space with main content.

import {
  type Component,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

interface SlidePanelProps {
  open: boolean;
  onClose: () => void;
  wide?: boolean;
  reader?: boolean;
  docked?: boolean;
  children: JSX.Element;
}

const PANEL_WIDTH_KEY = "seren:slide-panel-width";
const PANEL_WIDTH_DEFAULT = 420;
const PANEL_WIDTH_MIN = 320;
const PANEL_WIDTH_MAX_VW = 0.6;

function loadStoredWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return PANEL_WIDTH_DEFAULT;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= PANEL_WIDTH_MIN) {
      return parsed;
    }
  } catch {
    // Ignore storage errors
  }
  return PANEL_WIDTH_DEFAULT;
}

function persistWidth(width: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Ignore storage errors
  }
}

function maxAllowedWidth(viewport: number): number {
  return Math.max(PANEL_WIDTH_MIN, Math.round(viewport * PANEL_WIDTH_MAX_VW));
}

function clampWidth(width: number, viewport: number): number {
  return Math.max(PANEL_WIDTH_MIN, Math.min(maxAllowedWidth(viewport), width));
}

const [storedWidth, setStoredWidth] = createSignal(loadStoredWidth());

export const SlidePanel: Component<SlidePanelProps> = (props) => {
  const [dragging, setDragging] = createSignal(false);
  const [viewportWidth, setViewportWidth] = createSignal(
    typeof window === "undefined"
      ? PANEL_WIDTH_DEFAULT / PANEL_WIDTH_MAX_VW
      : window.innerWidth,
  );

  onMount(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });

  // Settings keeps its own wider width; everything else shares the user's
  // persisted preference, clamped against the current viewport so a width
  // saved on a larger display does not overflow on a smaller one.
  const effectiveWidth = () => clampWidth(storedWidth(), viewportWidth());
  const panelWidth = () =>
    props.reader ? "1040px" : props.wide ? "860px" : `${effectiveWidth()}px`;
  const resizable = () => !props.wide && !props.reader;

  const handleResizeStart = (event: PointerEvent) => {
    if (!resizable()) return;
    event.preventDefault();
    setDragging(true);
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      const viewport = window.innerWidth;
      setViewportWidth(viewport);
      setStoredWidth(clampWidth(viewport - move.clientX, viewport));
    };

    const onEnd = () => {
      setDragging(false);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onEnd);
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore release errors when capture was already lost
      }
      persistWidth(effectiveWidth());
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onEnd);
  };

  return (
    <Show when={props.open}>
      <div
        classList={{
          "absolute inset-0 z-[50] flex justify-end": !props.docked,
          "relative z-[1] shrink-0 h-full": props.docked,
        }}
      >
        <Show when={!props.docked}>
          <div
            class="absolute inset-0 bg-black/40 animate-[fadeIn_200ms_ease]"
            onClick={props.onClose}
          />
        </Show>
        <div
          class="relative max-w-[90vw] h-full bg-surface-1 border-l border-border overflow-x-hidden overflow-y-auto"
          classList={{
            "bg-surface-1/95 backdrop-blur-xl shadow-[var(--shadow-lg)] animate-[slideInRight_200ms_ease]":
              !props.docked,
          }}
          style={{ width: panelWidth() }}
        >
          <Show when={resizable()}>
            <div
              class="absolute top-0 left-0 bottom-0 w-1.5 -translate-x-1/2 cursor-col-resize z-20 group"
              onPointerDown={handleResizeStart}
              role="separator"
              aria-label="Resize panel"
              aria-orientation="vertical"
            >
              <div
                class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px transition-colors"
                classList={{
                  "bg-primary": dragging(),
                  "bg-transparent group-hover:bg-border": !dragging(),
                }}
              />
            </div>
          </Show>
          <button
            class="absolute top-3 right-3 w-7 h-7 flex items-center justify-center bg-transparent border-none rounded-md text-muted-foreground cursor-pointer z-[1] transition-all duration-100 hover:bg-surface-2 hover:text-foreground active:scale-95"
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
