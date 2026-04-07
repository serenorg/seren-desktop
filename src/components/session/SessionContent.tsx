// ABOUTME: Main content area for session threads.
// ABOUTME: Shows session state, context, timeline, and controls inline.

import { type Component, createEffect, Show } from "solid-js";
import { sessionStore } from "@/stores/session.store";
import { threadStore } from "@/stores/thread.store";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { SessionTimeline } from "./SessionTimeline";

export const SessionContent: Component = () => {
  const sessionId = () => {
    const thread = threadStore.activeThread;
    if (!thread) return null;
    return thread.id.replace("session:", "");
  };

  createEffect(() => {
    const id = sessionId();
    if (id) {
      sessionStore.setActiveSession(id);
      void sessionStore.loadEvents(id);
    }
  });

  const session = () => sessionStore.activeSession;
  const events = () => sessionStore.activeSessionEvents;

  const handleResume = async () => {
    const id = sessionId();
    if (id) await sessionStore.resumeSession(id);
  };

  const handlePause = async () => {
    const id = sessionId();
    if (id) await sessionStore.pauseSession(id);
  };

  const handleComplete = async () => {
    const id = sessionId();
    if (id) await sessionStore.completeSession(id);
  };

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <Show
        when={session()}
        fallback={
          <div class="flex items-center justify-center h-full text-muted-foreground text-[13px]">
            Session not found
          </div>
        }
      >
        {/* Session header */}
        <div class="px-5 py-4 border-b border-border/40 bg-surface-0/30">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-[16px] font-semibold text-foreground m-0">
                {session()!.title}
              </h2>
              <div class="flex items-center gap-2 mt-1.5">
                <SessionStatusBadge status={session()!.status} />
                <span class="text-[12px] text-muted-foreground capitalize">
                  {session()!.environment} runtime
                </span>
                <Show when={session()!.context?.url}>
                  <span class="text-[12px] text-primary/60 truncate max-w-[300px]">
                    {session()!.context!.url}
                  </span>
                </Show>
              </div>
            </div>

            {/* Action buttons */}
            <div class="flex items-center gap-1.5">
              <Show
                when={
                  session()!.status === "paused" || session()!.status === "idle"
                }
              >
                <button
                  type="button"
                  class="px-3 py-1.5 text-[12px] font-medium text-primary-foreground bg-primary rounded hover:bg-primary-hover transition-colors"
                  onClick={handleResume}
                >
                  Resume
                </button>
              </Show>
              <Show when={session()!.status === "running"}>
                <button
                  type="button"
                  class="px-3 py-1.5 text-[12px] font-medium text-violet-400 bg-violet-500/10 border border-violet-500/20 rounded hover:bg-violet-500/[0.18] transition-colors"
                  onClick={handlePause}
                >
                  Pause
                </button>
              </Show>
              <Show
                when={
                  session()!.status !== "completed" &&
                  session()!.status !== "error"
                }
              >
                <button
                  type="button"
                  class="px-3 py-1.5 text-[12px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded hover:bg-emerald-500/[0.18] transition-colors"
                  onClick={handleComplete}
                >
                  Complete
                </button>
              </Show>
            </div>
          </div>

          {/* Active tools / context */}
          <Show
            when={
              session()!.context?.active_tools &&
              session()!.context!.active_tools!.length > 0
            }
          >
            <div class="flex items-center gap-1.5 mt-2 flex-wrap">
              <span class="text-[11px] text-muted-foreground">Tools:</span>
              {session()!.context!.active_tools!.map((tool) => (
                <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-muted-foreground">
                  {tool}
                </span>
              ))}
            </div>
          </Show>
        </div>

        {/* Timeline area */}
        <div class="flex-1 overflow-auto px-5 py-3">
          <div class="max-w-[700px] mx-auto">
            <div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium mb-2">
              Activity Timeline
            </div>
            <SessionTimeline events={events()} />
          </div>
        </div>

        {/* Footer with session info */}
        <div class="px-5 py-2 border-t border-border/30 bg-surface-0/20">
          <div class="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              Created {new Date(session()!.created_at).toLocaleString()}
            </span>
            <span>
              {events().length} event{events().length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </Show>
    </div>
  );
};
