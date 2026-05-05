// ABOUTME: Tiles per-thread panes inside the active workspace's split layout.
// ABOUTME: Singleton-per-thread mounting; positions absolute, animated by layout.

import { type Component, createMemo, For, Show } from "solid-js";
import { AgentChat } from "@/components/chat/AgentChat";
import { ChatContent } from "@/components/chat/ChatContent";
import { TerminalBuffer } from "@/components/terminal/TerminalBuffer";
import { openFolder } from "@/lib/files/service";
import { fileTreeState } from "@/stores/fileTree";
import { type WorkspaceWindow, workspaceStore } from "@/stores/workspace.store";

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
  const mountedWindows = createMemo(() => {
    const out: Array<{ key: string; window: WorkspaceWindow }> = [];
    const seenThread = new Set<string>();
    const liveKeys = new Set<string>();
    for (const workspace of workspaceStore.workspaces) {
      for (const window of workspace.windows) {
        const key = window.threadId ?? window.id;
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

  // Compute the absolute placement (top/left/width/height) for a
  // mounted pane based on which active-workspace tile holds its
  // thread (or its placeholder id). Hidden placement = the pane is
  // mounted but parked off-layout because its thread isn't in the
  // active workspace right now.
  const placementFor = (window: WorkspaceWindow): PanePlacement => {
    const ws = workspaceStore.activeWorkspace;
    const idx = ws.windows.findIndex((w) =>
      window.threadId !== null
        ? w.threadId === window.threadId
        : w.id === window.id,
    );
    if (idx < 0) return { hidden: true };
    const sizes = ws.windows.map((w) => Math.max(w.size, 0.05));
    const totalSize = sizes.reduce((a, b) => a + b, 0);
    const before = sizes.slice(0, idx).reduce((a, b) => a + b, 0);
    // Carve out gutters from the available track length so each tile
    // accounts for its share of the dividers between siblings.
    const totalGutter = (ws.windows.length - 1) * GUTTER_PX;
    const startPct = (before / totalSize) * 100;
    const sizePct = (sizes[idx] / totalSize) * 100;
    const startCalc = `calc(${startPct}% + ${idx * GUTTER_PX - (totalGutter * before) / totalSize}px)`;
    const sizeCalc = `calc(${sizePct}% - ${(totalGutter * sizes[idx]) / totalSize}px)`;
    if (ws.splitDirection === "row") {
      return {
        hidden: false,
        top: "0",
        bottom: "0",
        left: startCalc,
        width: sizeCalc,
      };
    }
    return {
      hidden: false,
      left: "0",
      right: "0",
      top: startCalc,
      height: sizeCalc,
    };
  };

  // Gutters between adjacent tiles in the active workspace. One per
  // boundary, positioned at the cumulative offset of all preceding
  // tiles. Drag updates the size ratio of the two tiles it borders.
  const gutters = createMemo(() => {
    const ws = workspaceStore.activeWorkspace;
    if (ws.windows.length < 2) return [];
    const sizes = ws.windows.map((w) => Math.max(w.size, 0.05));
    const totalSize = sizes.reduce((a, b) => a + b, 0);
    const totalGutter = (ws.windows.length - 1) * GUTTER_PX;
    const out: Array<{
      key: string;
      style: Record<string, string>;
      leftId: string;
      rightId: string;
    }> = [];
    let cumSize = 0;
    for (let i = 0; i < ws.windows.length - 1; i++) {
      cumSize += sizes[i];
      const startPct = (cumSize / totalSize) * 100;
      const startCalc = `calc(${startPct}% + ${
        (i + 1) * GUTTER_PX - (totalGutter * cumSize) / totalSize - GUTTER_PX
      }px)`;
      const style: Record<string, string> =
        ws.splitDirection === "row"
          ? {
              position: "absolute",
              top: "0",
              bottom: "0",
              left: startCalc,
              width: `${GUTTER_PX}px`,
              cursor: "col-resize",
            }
          : {
              position: "absolute",
              left: "0",
              right: "0",
              top: startCalc,
              height: `${GUTTER_PX}px`,
              cursor: "row-resize",
            };
      out.push({
        key: `${ws.number}-${ws.windows[i].id}-${ws.windows[i + 1].id}`,
        style,
        leftId: ws.windows[i].id,
        rightId: ws.windows[i + 1].id,
      });
    }
    return out;
  });

  const onGutterPointerDown = (
    e: PointerEvent,
    leftId: string,
    rightId: string,
  ) => {
    e.preventDefault();
    const ws = workspaceStore.activeWorkspace;
    const left = ws.windows.find((w) => w.id === leftId);
    const right = ws.windows.find((w) => w.id === rightId);
    if (!left || !right) return;
    const startSize = left.size + right.size;
    const horizontal = ws.splitDirection === "row";
    const container =
      (e.currentTarget as HTMLElement).parentElement ?? document.body;
    const rect = container.getBoundingClientRect();
    const trackPx = horizontal ? rect.width : rect.height;
    if (trackPx <= 0) return;
    const startPos = horizontal ? e.clientX : e.clientY;
    const startLeftFraction = left.size / startSize;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);

    const move = (event: PointerEvent) => {
      const delta = (horizontal ? event.clientX : event.clientY) - startPos;
      const deltaFraction = delta / trackPx;
      const nextLeftFraction = Math.min(
        0.95,
        Math.max(0.05, startLeftFraction + deltaFraction),
      );
      const nextLeft = nextLeftFraction * startSize;
      const nextRight = startSize - nextLeft;
      workspaceStore.resizePanes([
        { id: leftId, size: nextLeft },
        { id: rightId, size: nextRight },
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
      (window.threadId !== null
        ? ws.windows.some(
            (w) =>
              w.threadId === window.threadId && w.id === ws.focusedWindowId,
          )
        : ws.focusedWindowId === window.id)
    );
  };

  const handlePaneFocus = (window: WorkspaceWindow) => {
    const ws = workspaceStore.activeWorkspace;
    const target = ws.windows.find((w) =>
      window.threadId !== null
        ? w.threadId === window.threadId
        : w.id === window.id,
    );
    if (target) workspaceStore.focusWindow(target.id);
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
                class="flex flex-col min-h-0 overflow-hidden rounded-[3px] transition-[outline-color] duration-100"
                classList={{
                  "outline outline-[1.5px] outline-offset-[-1.5px] outline-primary/70":
                    !hidden() && focused(),
                  "outline outline-[1px] outline-offset-[-1px] outline-border/40":
                    !hidden() && !focused(),
                  "pointer-events-none": hidden(),
                }}
              >
                <Show
                  when={entry.window.kind === "chat" && entry.window.threadId}
                >
                  <ChatContent
                    threadId={entry.window.threadId ?? ""}
                    active={!hidden() && focused()}
                    onSignInClick={props.onSignInClick}
                  />
                </Show>
                <Show
                  when={entry.window.kind === "agent" && entry.window.threadId}
                >
                  <AgentChat
                    threadId={entry.window.threadId ?? ""}
                    active={!hidden() && focused()}
                  />
                </Show>
                <Show
                  when={
                    entry.window.kind === "terminal" && entry.window.threadId
                  }
                >
                  <TerminalBuffer threadId={entry.window.threadId ?? ""} />
                </Show>
                <Show when={entry.window.threadId === null}>
                  <PlaceholderPane focused={focused()} />
                </Show>
              </div>
            );
          }}
        </For>

        {/* Gutters: rendered above panes so their cursor + drag wins. */}
        <For each={gutters()}>
          {(gutter) => (
            <div
              style={gutter.style}
              class="z-10 group flex items-center justify-center"
              role="separator"
              aria-orientation={
                workspaceStore.activeWorkspace.splitDirection === "row"
                  ? "vertical"
                  : "horizontal"
              }
              onPointerDown={(e) =>
                onGutterPointerDown(e, gutter.leftId, gutter.rightId)
              }
            >
              <div
                aria-hidden="true"
                class="bg-border/20 group-hover:bg-primary/40 transition-colors duration-100"
                classList={{
                  "w-px h-full":
                    workspaceStore.activeWorkspace.splitDirection === "row",
                  "h-px w-full":
                    workspaceStore.activeWorkspace.splitDirection === "column",
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
    class="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground/70 select-none"
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
      class="opacity-30"
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
    <p class="text-[12px] leading-tight max-w-[220px] text-center">
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
      <div class="opacity-40">
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
            opacity="0.3"
          />
          <path
            d="M16 20h16M16 26h10"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            opacity="0.3"
          />
        </svg>
      </div>
      <h2 class="text-base font-medium text-foreground opacity-70 m-0">
        No thread selected
      </h2>
      <p class="text-[13px] opacity-50 m-0 max-w-[280px] text-center leading-relaxed">
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
