// ABOUTME: Main session panel showing runtime session details, controls, and timeline.
// ABOUTME: Provides session lifecycle management (create, pause, resume, complete, delete).

import {
  type Component,
  createEffect,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { sessionStore } from "@/stores/session.store";
import type { SessionEnvironment } from "@/types/session";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { SessionTimeline } from "./SessionTimeline";

interface SessionPanelProps {
  onClose?: () => void;
}

export const SessionPanel: Component<SessionPanelProps> = (props) => {
  const [showCreate, setShowCreate] = createSignal(false);
  const [newTitle, setNewTitle] = createSignal("");
  const [newEnv, setNewEnv] = createSignal<SessionEnvironment>("browser");
  const [isCreating, setIsCreating] = createSignal(false);

  createEffect(() => {
    void sessionStore.loadSessions();
  });

  createEffect(() => {
    const id = sessionStore.activeSessionId;
    if (id) {
      void sessionStore.loadEvents(id);
    }
  });

  const handleCreate = async () => {
    const title = newTitle().trim() || "New Session";
    setIsCreating(true);
    try {
      const session = await sessionStore.createSession(title, newEnv());
      sessionStore.setActiveSession(session.id);
      setShowCreate(false);
      setNewTitle("");
    } finally {
      setIsCreating(false);
    }
  };

  const handleResume = async () => {
    const id = sessionStore.activeSessionId;
    if (id) await sessionStore.resumeSession(id);
  };

  const handlePause = async () => {
    const id = sessionStore.activeSessionId;
    if (id) await sessionStore.pauseSession(id);
  };

  const handleComplete = async () => {
    const id = sessionStore.activeSessionId;
    if (id) await sessionStore.completeSession(id);
  };

  const handleDelete = async () => {
    const id = sessionStore.activeSessionId;
    if (id) await sessionStore.deleteSession(id);
  };

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div class="flex items-center gap-2">
          <h2 class="text-[15px] font-semibold text-foreground m-0">
            Sessions
          </h2>
          <Show when={sessionStore.activeSessions.length > 0}>
            <span class="text-[11px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary font-medium">
              {sessionStore.activeSessions.length}
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="px-2.5 py-1 text-[12px] font-medium text-primary bg-primary/10 rounded hover:bg-primary/[0.18] transition-colors"
            onClick={() => setShowCreate(!showCreate())}
          >
            {showCreate() ? "Cancel" : "+ New"}
          </button>
          <Show when={props.onClose}>
            <button
              type="button"
              class="p-1 text-muted-foreground hover:text-foreground transition-colors rounded"
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
          </Show>
        </div>
      </div>

      {/* Create form */}
      <Show when={showCreate()}>
        <div class="px-4 py-3 border-b border-border/50 bg-surface-0/50">
          <div class="flex flex-col gap-2">
            <input
              type="text"
              placeholder="Session title..."
              value={newTitle()}
              onInput={(e) => setNewTitle(e.currentTarget.value)}
              class="w-full px-2.5 py-1.5 text-[13px] bg-surface-1 border border-border/50 rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
              }}
            />
            <div class="flex items-center gap-2">
              <select
                value={newEnv()}
                onChange={(e) =>
                  setNewEnv(e.currentTarget.value as SessionEnvironment)
                }
                class="flex-1 px-2.5 py-1.5 text-[13px] bg-surface-1 border border-border/50 rounded text-foreground focus:outline-none focus:border-primary/50"
              >
                <option value="browser">Browser</option>
                <option value="desktop">Desktop</option>
                <option value="file">File</option>
              </select>
              <button
                type="button"
                class="px-3 py-1.5 text-[12px] font-medium text-primary-foreground bg-primary rounded hover:bg-primary-hover transition-colors disabled:opacity-50"
                onClick={handleCreate}
                disabled={isCreating()}
              >
                {isCreating() ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Content: session list or active session detail */}
      <div class="flex-1 overflow-auto">
        <Switch
          fallback={
            <SessionListView
              sessions={sessionStore.sessions}
              onSelect={(id) => {
                sessionStore.setActiveSession(id);
              }}
            />
          }
        >
          <Match when={sessionStore.activeSession}>
            <div class="flex flex-col h-full">
              {/* Active session header */}
              <div class="px-4 py-3 border-b border-border/30">
                <div class="flex items-center gap-2 mb-1">
                  <button
                    type="button"
                    class="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => sessionStore.setActiveSession(null)}
                  >
                    &larr; All sessions
                  </button>
                </div>
                <div class="flex items-center justify-between">
                  <div>
                    <h3 class="text-[14px] font-medium text-foreground m-0">
                      {sessionStore.activeSession!.title}
                    </h3>
                    <div class="flex items-center gap-2 mt-1">
                      <SessionStatusBadge
                        status={sessionStore.activeSession!.status}
                      />
                      <span class="text-[11px] text-muted-foreground capitalize">
                        {sessionStore.activeSession!.environment}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Context info */}
                <Show when={sessionStore.activeSession!.context?.url}>
                  <div class="mt-2 text-[12px] text-primary/70 truncate">
                    {sessionStore.activeSession!.context!.url}
                  </div>
                </Show>

                {/* Action buttons */}
                <div class="flex items-center gap-1.5 mt-3">
                  <Show
                    when={
                      sessionStore.activeSession!.status === "paused" ||
                      sessionStore.activeSession!.status === "idle"
                    }
                  >
                    <button
                      type="button"
                      class="px-2.5 py-1 text-[12px] font-medium text-primary bg-primary/10 rounded hover:bg-primary/[0.18] transition-colors"
                      onClick={handleResume}
                    >
                      Resume
                    </button>
                  </Show>
                  <Show when={sessionStore.activeSession!.status === "running"}>
                    <button
                      type="button"
                      class="px-2.5 py-1 text-[12px] font-medium text-violet-400 bg-violet-500/10 rounded hover:bg-violet-500/[0.18] transition-colors"
                      onClick={handlePause}
                    >
                      Pause
                    </button>
                  </Show>
                  <Show
                    when={
                      sessionStore.activeSession!.status !== "completed" &&
                      sessionStore.activeSession!.status !== "error"
                    }
                  >
                    <button
                      type="button"
                      class="px-2.5 py-1 text-[12px] font-medium text-emerald-400 bg-emerald-500/10 rounded hover:bg-emerald-500/[0.18] transition-colors"
                      onClick={handleComplete}
                    >
                      Complete
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="px-2.5 py-1 text-[12px] font-medium text-red-400 bg-red-500/10 rounded hover:bg-red-500/[0.18] transition-colors ml-auto"
                    onClick={handleDelete}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Timeline */}
              <div class="flex-1 overflow-auto px-3 py-2">
                <div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium px-1 py-2">
                  Timeline
                </div>
                <SessionTimeline events={sessionStore.activeSessionEvents} />
              </div>
            </div>
          </Match>
        </Switch>
      </div>

      {/* Background session indicator */}
      <Show when={sessionStore.backgroundSessions.length > 0}>
        <div class="px-4 py-2 border-t border-border/50 bg-surface-0/50">
          <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            {sessionStore.backgroundSessions.length} session
            {sessionStore.backgroundSessions.length > 1 ? "s" : ""} running in
            background
          </div>
        </div>
      </Show>
    </div>
  );
};

// ============================================================================
// Session List View
// ============================================================================

const SessionListView: Component<{
  sessions: import("@/types/session").RuntimeSession[];
  onSelect: (id: string) => void;
}> = (props) => {
  return (
    <Show
      when={props.sessions.length > 0}
      fallback={
        <div class="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <div class="text-[32px] opacity-30 mb-3">&#9684;</div>
          <p class="text-[13px] font-medium opacity-70 m-0">No sessions yet</p>
          <p class="text-[12px] opacity-50 m-0 mt-1">
            Create a session to start a computer-use runtime
          </p>
        </div>
      }
    >
      <div class="flex flex-col">
        <For each={props.sessions}>
          {(session) => (
            <button
              type="button"
              class="flex items-center gap-3 px-4 py-3 border-b border-border/20 hover:bg-surface-1/50 transition-colors cursor-pointer text-left w-full bg-transparent border-none"
              onClick={() => props.onSelect(session.id)}
            >
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-medium text-foreground truncate">
                    {session.title}
                  </span>
                  <SessionStatusBadge status={session.status} />
                </div>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-[11px] text-muted-foreground capitalize">
                    {session.environment}
                  </span>
                  <Show when={session.context?.url}>
                    <span class="text-[11px] text-primary/50 truncate max-w-[180px]">
                      {session.context!.url}
                    </span>
                  </Show>
                </div>
              </div>
              <span class="text-[11px] text-muted-foreground flex-shrink-0">
                {formatRelativeTime(session.updated_at)}
              </span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
