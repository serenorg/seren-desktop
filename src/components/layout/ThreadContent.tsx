// ABOUTME: Tiles per-thread panes inside the active workspace's split layout.
// ABOUTME: Singleton-per-thread mounting; positions absolute, animated by layout.

import { type Component, createMemo, createSignal, For, Show } from "solid-js";
import { AgentChat } from "@/components/chat/AgentChat";
import { ChatContent } from "@/components/chat/ChatContent";
import { EditorContent } from "@/components/editor/EditorContent";
import { TerminalBuffer } from "@/components/terminal/TerminalBuffer";
import { openFolder } from "@/lib/files/service";
import {
  canAcceptSkillDrop,
  draftSkillInvocationFromDrag,
  setCurrentSkillDragPayload,
  skillDragPayload,
} from "@/lib/skill-drag";
import {
  decodeThreadDragPayload,
  getCurrentThreadDragPayload,
  setCurrentThreadDragPayload,
  THREAD_DRAG_MIME,
} from "@/lib/thread-drag";
import { fileTreeState } from "@/stores/fileTree";
import { threadStore } from "@/stores/thread.store";
import {
  type SplitDirection,
  type WorkspaceLayout,
  type WorkspaceWindow,
  workspaceStore,
} from "@/stores/workspace.store";

interface ThreadContentProps {
  onSignInClick: () => void;
}

interface PanePlacement {
  hidden: boolean;
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  width?: string;
  height?: string;
}

interface LayoutRect {
  topPct: number;
  leftPct: number;
  widthPct: number;
  heightPct: number;
  topPx: number;
  leftPx: number;
  widthPx: number;
  heightPx: number;
}

interface GutterPlacement {
  key: string;
  style: Record<string, string>;
  leftId: string;
  rightId: string;
  direction: SplitDirection;
  leftSize: number;
  rightSize: number;
  totalSize: number;
  totalGutter: number;
  trackPct: number;
  trackPx: number;
}

// Width of the gutter strip between adjacent tiles in pixels.
// Same value drives both the rendered handle and the placement math.
const GUTTER_PX = 6;

export const ThreadContent: Component<ThreadContentProps> = (props) => {
  // Singleton-per-thread: a Map<threadId, window> picks the first
  // window across all workspaces that owns this thread, so the same
  // thread mounted in two workspaces shares one component instance.
  // Placeholder windows (null threadId) get keyed by their pane id so
  // each placeholder still gets its own slot.
  //
  // Wrappers are cached across memo runs so <For> sees stable references
  // for the same key. Without this cache, every store update would emit
  // fresh wrapper objects and <For> would unmount/remount every pane -
  // losing chat scroll, draft input, and terminal IPC subscriptions on
  // each tick (e.g. during a drag-resize).
  const wrapperCache = new Map<
    string,
    { key: string; window: WorkspaceWindow }
  >();
  const [dragTargetWindowId, setDragTargetWindowId] = createSignal<
    string | null
  >(null);
  const mountedWindows = createMemo(() => {
    const out: Array<{ key: string; window: WorkspaceWindow }> = [];
    const seenThread = new Set<string>();
    const liveKeys = new Set<string>();
    for (const workspace of workspaceStore.workspaces) {
      for (const window of workspace.windows) {
        const key =
          window.kind === "editor"
            ? "editor:singleton"
            : window.threadId !== null
              ? `thread:${window.threadId}`
              : `pane:${workspace.number}:${window.id}`;
        if (window.threadId !== null) {
          if (seenThread.has(window.threadId)) continue;
          seenThread.add(window.threadId);
        }
        liveKeys.add(key);
        const cached = wrapperCache.get(key);
        if (cached && cached.window === window) {
          out.push(cached);
        } else {
          const wrapper = { key, window };
          wrapperCache.set(key, wrapper);
          out.push(wrapper);
        }
      }
    }
    for (const key of [...wrapperCache.keys()]) {
      if (!liveKeys.has(key)) wrapperCache.delete(key);
    }
    return out;
  });

  const formatCalc = (pct: number, px: number) => `calc(${pct}% + ${px}px)`;
  const rectToPlacement = (rect: LayoutRect): PanePlacement => ({
    hidden: false,
    top: formatCalc(rect.topPct, rect.topPx),
    left: formatCalc(rect.leftPct, rect.leftPx),
    width: formatCalc(rect.widthPct, rect.widthPx),
    height: formatCalc(rect.heightPct, rect.heightPx),
  });

  const layoutGeometry = createMemo(() => {
    const ws = workspaceStore.activeWorkspace;
    const placements = new Map<string, PanePlacement>();
    const gutters: GutterPlacement[] = [];

    const walk = (layout: WorkspaceLayout, rect: LayoutRect) => {
      if (layout.type === "pane") {
        placements.set(layout.windowId, rectToPlacement(rect));
        return;
      }

      const sizes = layout.children.map((child) => Math.max(child.size, 0.05));
      const totalSize = sizes.reduce((a, b) => a + b, 0);
      const totalGutter = (layout.children.length - 1) * GUTTER_PX;
      let before = 0;

      for (let i = 0; i < layout.children.length; i++) {
        const child = layout.children[i];
        const size = sizes[i];
        const startRatio = before / totalSize;
        const sizeRatio = size / totalSize;
        const childRect: LayoutRect =
          layout.direction === "row"
            ? {
                topPct: rect.topPct,
                leftPct: rect.leftPct + rect.widthPct * startRatio,
                widthPct: rect.widthPct * sizeRatio,
                heightPct: rect.heightPct,
                topPx: rect.topPx,
                leftPx:
                  rect.leftPx +
                  rect.widthPx * startRatio +
                  i * GUTTER_PX -
                  totalGutter * startRatio,
                widthPx: rect.widthPx * sizeRatio - totalGutter * sizeRatio,
                heightPx: rect.heightPx,
              }
            : {
                topPct: rect.topPct + rect.heightPct * startRatio,
                leftPct: rect.leftPct,
                widthPct: rect.widthPct,
                heightPct: rect.heightPct * sizeRatio,
                topPx:
                  rect.topPx +
                  rect.heightPx * startRatio +
                  i * GUTTER_PX -
                  totalGutter * startRatio,
                leftPx: rect.leftPx,
                widthPx: rect.widthPx,
                heightPx: rect.heightPx * sizeRatio - totalGutter * sizeRatio,
              };
        walk(child, childRect);

        before += size;
        if (i < layout.children.length - 1) {
          const boundaryRatio = before / totalSize;
          const gutterRect: LayoutRect =
            layout.direction === "row"
              ? {
                  topPct: rect.topPct,
                  leftPct: rect.leftPct + rect.widthPct * boundaryRatio,
                  widthPct: 0,
                  heightPct: rect.heightPct,
                  topPx: rect.topPx,
                  leftPx:
                    rect.leftPx +
                    rect.widthPx * boundaryRatio +
                    (i + 1) * GUTTER_PX -
                    totalGutter * boundaryRatio -
                    GUTTER_PX,
                  widthPx: GUTTER_PX,
                  heightPx: rect.heightPx,
                }
              : {
                  topPct: rect.topPct + rect.heightPct * boundaryRatio,
                  leftPct: rect.leftPct,
                  widthPct: rect.widthPct,
                  heightPct: 0,
                  topPx:
                    rect.topPx +
                    rect.heightPx * boundaryRatio +
                    (i + 1) * GUTTER_PX -
                    totalGutter * boundaryRatio -
                    GUTTER_PX,
                  leftPx: rect.leftPx,
                  widthPx: rect.widthPx,
                  heightPx: GUTTER_PX,
                };
          gutters.push({
            key: `${ws.number}-${layout.id}-${i}`,
            style: {
              position: "absolute",
              top: formatCalc(gutterRect.topPct, gutterRect.topPx),
              left: formatCalc(gutterRect.leftPct, gutterRect.leftPx),
              width: formatCalc(gutterRect.widthPct, gutterRect.widthPx),
              height: formatCalc(gutterRect.heightPct, gutterRect.heightPx),
              cursor: layout.direction === "row" ? "col-resize" : "row-resize",
            },
            leftId: layout.children[i].id,
            rightId: layout.children[i + 1].id,
            direction: layout.direction,
            leftSize: sizes[i],
            rightSize: sizes[i + 1],
            totalSize,
            totalGutter,
            trackPct:
              layout.direction === "row" ? rect.widthPct : rect.heightPct,
            trackPx: layout.direction === "row" ? rect.widthPx : rect.heightPx,
          });
        }
      }
    };

    if (ws.layout) {
      walk(ws.layout, {
        topPct: 0,
        leftPct: 0,
        widthPct: 100,
        heightPct: 100,
        topPx: 0,
        leftPx: 0,
        widthPx: 0,
        heightPx: 0,
      });
    }

    return { placements, gutters };
  });

  const windowMatches = (
    candidate: WorkspaceWindow,
    source: WorkspaceWindow,
  ): boolean => {
    if (source.kind === "editor") {
      return candidate.kind === "editor";
    }
    if (source.threadId !== null) {
      return candidate.threadId === source.threadId;
    }
    return candidate.id === source.id;
  };

  const activeTargetFor = (
    window: WorkspaceWindow,
  ): WorkspaceWindow | undefined => {
    const ws = workspaceStore.activeWorkspace;
    return ws.windows.find((w) => windowMatches(w, window));
  };

  const placementFor = (window: WorkspaceWindow): PanePlacement => {
    const target = activeTargetFor(window);
    if (!target) return { hidden: true };
    return layoutGeometry().placements.get(target.id) ?? { hidden: true };
  };

  const onGutterPointerDown = (e: PointerEvent, gutter: GutterPlacement) => {
    e.preventDefault();
    const startSize = gutter.leftSize + gutter.rightSize;
    const horizontal = gutter.direction === "row";
    const container =
      (e.currentTarget as HTMLElement).parentElement ?? document.body;
    const rect = container.getBoundingClientRect();
    const rootTrackPx = horizontal ? rect.width : rect.height;
    const trackPx = (rootTrackPx * gutter.trackPct) / 100 + gutter.trackPx;
    const availableTrackPx = trackPx - gutter.totalGutter;
    if (availableTrackPx <= 0) return;
    const startPos = horizontal ? e.clientX : e.clientY;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);

    const move = (event: PointerEvent) => {
      const delta = (horizontal ? event.clientX : event.clientY) - startPos;
      const deltaSize = (delta / availableTrackPx) * gutter.totalSize;
      const nextLeft = Math.min(
        startSize - 0.05,
        Math.max(0.05, gutter.leftSize + deltaSize),
      );
      const nextRight = startSize - nextLeft;
      workspaceStore.resizePanes([
        { id: gutter.leftId, size: nextLeft },
        { id: gutter.rightId, size: nextRight },
      ]);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const isFocused = (window: WorkspaceWindow): boolean => {
    const ws = workspaceStore.activeWorkspace;
    return (
      ws.focusedWindowId !== null &&
      ws.windows.some(
        (w) => w.id === ws.focusedWindowId && windowMatches(w, window),
      )
    );
  };
  const showFocusedOutline = () =>
    workspaceStore.activeWorkspace.windows.length > 1;

  const handlePaneFocus = (window: WorkspaceWindow) => {
    const ws = workspaceStore.activeWorkspace;
    const target = ws.windows.find((w) => windowMatches(w, window));
    if (target) workspaceStore.focusWindow(target.id);
  };

  const threadDragPayload = (event: DragEvent) => {
    const value =
      event.dataTransfer?.getData(THREAD_DRAG_MIME) ||
      event.dataTransfer?.getData("text/plain");
    return value
      ? (decodeThreadDragPayload(value) ?? getCurrentThreadDragPayload())
      : getCurrentThreadDragPayload();
  };

  const canAcceptThreadDrop = (event: DragEvent) => {
    if (getCurrentThreadDragPayload() !== null) return true;

    const types = Array.from(event.dataTransfer?.types ?? []);
    if (types.includes(THREAD_DRAG_MIME)) return true;
    if (!types.includes("text/plain")) return false;

    const text = event.dataTransfer?.getData("text/plain");
    return text ? decodeThreadDragPayload(text) !== null : false;
  };

  const skillDropThreadIdFor = (window: WorkspaceWindow): string | null => {
    const target = activeTargetFor(window);
    if (!target?.threadId) return null;
    return target.kind === "chat" || target.kind === "agent"
      ? target.threadId
      : null;
  };

  const skillDropKindFor = (
    window: WorkspaceWindow,
  ): "chat" | "agent" | null => {
    const target = activeTargetFor(window);
    if (!target?.threadId) return null;
    return target.kind === "chat" || target.kind === "agent"
      ? target.kind
      : null;
  };

  const handlePaneDragOver = (event: DragEvent, window: WorkspaceWindow) => {
    const skillThreadId = skillDropThreadIdFor(window);
    if (skillThreadId && canAcceptSkillDrop(event)) {
      const target = activeTargetFor(window);
      if (!target) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
      if (dragTargetWindowId() !== target.id) {
        setDragTargetWindowId(target.id);
      }
      return;
    }

    if (!canAcceptThreadDrop(event)) return;
    const target = activeTargetFor(window);
    if (!target) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    if (dragTargetWindowId() !== target.id) {
      setDragTargetWindowId(target.id);
    }
  };

  const handlePaneDrop = async (event: DragEvent, window: WorkspaceWindow) => {
    if (event.defaultPrevented) return;

    const skillKind = skillDropKindFor(window);
    const skillThreadId = skillDropThreadIdFor(window);
    const skillPayload =
      skillKind && skillThreadId ? skillDragPayload(event) : null;
    if (skillPayload && skillKind && skillThreadId) {
      event.preventDefault();
      setDragTargetWindowId(null);
      setCurrentSkillDragPayload(null);
      try {
        await draftSkillInvocationFromDrag(skillPayload, {
          kind: skillKind,
          threadId: skillThreadId,
        });
      } catch (err) {
        console.error("[ThreadContent] Failed to draft skill invocation:", err);
      }
      return;
    }

    const payload = threadDragPayload(event);
    if (!payload) return;
    const target = activeTargetFor(window);
    if (!target) return;
    event.preventDefault();
    setDragTargetWindowId(null);
    setCurrentThreadDragPayload(null);
    workspaceStore.bindThreadToWindow(target.id, payload.id);
  };

  return (
    <div
      id="workspace-content-panel"
      role="tabpanel"
      aria-label="Workspace content"
      tabIndex={-1}
      class="relative flex flex-col h-full overflow-hidden"
    >
      <div class="relative flex-1 overflow-hidden min-h-0">
        <For each={mountedWindows()}>
          {(entry) => {
            const placement = () => placementFor(entry.window);
            const focused = () => isFocused(entry.window);
            const hidden = () => placement().hidden;
            const dragTarget = () => {
              const target = activeTargetFor(entry.window);
              return target !== undefined && dragTargetWindowId() === target.id;
            };
            const baseStyle = () => {
              const p = placement();
              if (p.hidden) return { display: "none" };
              const style: Record<string, string> = { position: "absolute" };
              if (p.top !== undefined) style.top = p.top;
              if (p.left !== undefined) style.left = p.left;
              if (p.right !== undefined) style.right = p.right;
              if (p.bottom !== undefined) style.bottom = p.bottom;
              if (p.width !== undefined) style.width = p.width;
              if (p.height !== undefined) style.height = p.height;
              return style;
            };
            return (
              <div
                style={baseStyle()}
                aria-hidden={hidden()}
                onMouseDown={() => !hidden() && handlePaneFocus(entry.window)}
                onFocusIn={() => !hidden() && handlePaneFocus(entry.window)}
                onDragOver={(e) =>
                  !hidden() && handlePaneDragOver(e, entry.window)
                }
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node)) {
                    return;
                  }
                  if (dragTarget()) setDragTargetWindowId(null);
                }}
                onDrop={(e) =>
                  !hidden() && void handlePaneDrop(e, entry.window)
                }
                class="relative flex flex-col min-h-0 overflow-hidden rounded-[3px] transition-colors duration-100"
                classList={{
                  "outline outline-[1px] outline-offset-[-1px] outline-border/40":
                    !hidden() && !focused(),
                  "bg-primary/[0.04]": !hidden() && dragTarget(),
                  "pointer-events-none": hidden(),
                }}
              >
                {/*
                  Shell selection for conversation panes is driven by the
                  LIVE conversation row's kind, not the pane's static
                  `window.kind`. A cross-category provider switch flips
                  `conversations.kind` in DB; once the unified view
                  reflects that, this Show re-resolves and the shell
                  remounts from ChatContent to AgentChat (or vice versa)
                  in place. The pane's own `kind` is used only as the
                  initial-mount hint and as the fallback when the live
                  row hasn't loaded yet (so a freshly-restored pane
                  doesn't flash empty before the conversation list
                  hydrates).
                */}
                <Show
                  when={
                    (entry.window.kind === "chat" ||
                      entry.window.kind === "agent") &&
                    entry.window.threadId
                      ? entry.window.threadId
                      : null
                  }
                >
                  {(threadId) => {
                    const liveKind = createMemo(() => {
                      const row = threadStore.findConversation(threadId());
                      if (row) return row.kind;
                      // Fall back to the pane's static kind until the
                      // unified view has the row.
                      return entry.window.kind === "agent" ? "agent" : "chat";
                    });
                    return (
                      <Show
                        when={liveKind() === "chat"}
                        fallback={
                          <AgentChat
                            threadId={threadId()}
                            active={!hidden() && focused()}
                          />
                        }
                      >
                        <ChatContent
                          threadId={threadId()}
                          active={!hidden() && focused()}
                          onSignInClick={props.onSignInClick}
                        />
                      </Show>
                    );
                  }}
                </Show>
                <Show
                  when={
                    entry.window.kind === "terminal"
                      ? entry.window.threadId
                      : null
                  }
                >
                  {(threadId) => <TerminalBuffer threadId={threadId()} />}
                </Show>
                <Show when={entry.window.kind === "editor" ? true : null}>
                  <EditorContent
                    active={!hidden() && focused()}
                    onClose={() => {
                      handlePaneFocus(entry.window);
                      workspaceStore.closeFocusedWindow();
                    }}
                  />
                </Show>
                <Show when={entry.window.kind === null}>
                  <PlaceholderPane focused={focused()} />
                </Show>
                <Show
                  when={
                    !hidden() &&
                    ((showFocusedOutline() && focused()) || dragTarget())
                  }
                >
                  <div
                    aria-hidden="true"
                    class="absolute inset-0 rounded-[3px] pointer-events-none z-[5]"
                    classList={{
                      "border border-primary/45 shadow-[inset_0_0_0_1px_rgba(125,211,252,0.1),0_0_0_1px_rgba(56,189,248,0.08)]":
                        showFocusedOutline() && focused() && !dragTarget(),
                      "border border-primary/70 bg-primary/[0.05] shadow-[inset_0_0_0_1px_rgba(125,211,252,0.22),0_0_0_1px_rgba(56,189,248,0.14)]":
                        dragTarget(),
                    }}
                  />
                </Show>
              </div>
            );
          }}
        </For>

        {/* Gutters: rendered above panes so their cursor + drag wins. */}
        <For each={layoutGeometry().gutters}>
          {(gutter) => (
            <div
              style={gutter.style}
              class="z-10 group flex items-center justify-center"
              role="separator"
              aria-orientation={
                gutter.direction === "row" ? "vertical" : "horizontal"
              }
              onPointerDown={(e) => onGutterPointerDown(e, gutter)}
            >
              <div
                aria-hidden="true"
                class="bg-border/20 group-hover:bg-primary/40 transition-colors duration-100"
                classList={{
                  "w-px h-full": gutter.direction === "row",
                  "h-px w-full": gutter.direction === "column",
                }}
              />
            </div>
          )}
        </For>

        <Show when={workspaceStore.activeWorkspace.windows.length === 0}>
          <EmptyState />
        </Show>
      </div>
    </div>
  );
};

const PlaceholderPane: Component<{ focused: boolean }> = (props) => (
  <div
    class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground select-none"
    classList={{
      "bg-surface-1/40": props.focused,
    }}
  >
    <svg
      width="36"
      height="36"
      viewBox="0 0 36 36"
      fill="none"
      role="img"
      aria-label="Empty pane"
      class="opacity-65"
    >
      <rect
        x="3"
        y="3"
        width="30"
        height="30"
        rx="3"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray="3 3"
      />
      <path
        d="M18 12v12M12 18h12"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
    <p class="m-0 text-[13px] leading-normal max-w-[240px] text-center">
      Empty pane. Pick a thread from the sidebar or open a new one.
    </p>
  </div>
);

function EmptyState() {
  const handleOpenFolder = async () => {
    await openFolder();
  };

  return (
    <div class="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
      <div class="opacity-65">
        <svg
          width="48"
          height="48"
          viewBox="0 0 48 48"
          fill="none"
          role="img"
          aria-label="No thread selected"
        >
          <rect
            x="4"
            y="8"
            width="40"
            height="32"
            rx="4"
            stroke="currentColor"
            stroke-width="1.5"
            opacity="0.55"
          />
          <path
            d="M16 20h16M16 26h10"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            opacity="0.55"
          />
        </svg>
      </div>
      <h2 class="text-base font-medium text-foreground m-0">
        No thread selected
      </h2>
      <p class="text-[13px] m-0 max-w-[280px] text-center leading-relaxed">
        Create a new chat or agent thread from the sidebar to get started.
      </p>

      <Show when={!fileTreeState.rootPath}>
        <button
          type="button"
          class="mt-2 px-3.5 py-1.5 text-[13px] font-medium text-primary bg-primary/10 border border-transparent rounded-md cursor-pointer transition-all duration-100 hover:bg-primary/[0.18] hover:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleOpenFolder}
        >
          Open Folder
        </button>
      </Show>
    </div>
  );
}
