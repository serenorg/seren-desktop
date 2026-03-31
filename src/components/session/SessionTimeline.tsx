// ABOUTME: Audit timeline showing all events in a runtime session.
// ABOUTME: Renders actions, screenshots, approvals, and errors chronologically.

import { type Component, For, Show } from "solid-js";
import type { SessionEvent, SessionEventType } from "@/types/session";

interface SessionTimelineProps {
  events: SessionEvent[];
}

const EVENT_ICONS: Record<SessionEventType, string> = {
  navigation: "\u2192",
  action: "\u26A1",
  screenshot: "\uD83D\uDCF7",
  approval: "\u2714",
  content: "\uD83D\uDCC4",
  command: "\u003E_",
  error: "\u26A0",
  status_change: "\u25CF",
};

const EVENT_COLORS: Record<SessionEventType, string> = {
  navigation: "border-primary/40 bg-primary/8",
  action: "border-sky-400/40 bg-sky-400/8",
  screenshot: "border-violet-400/40 bg-violet-400/8",
  approval: "border-amber-400/40 bg-amber-400/8",
  content: "border-emerald-400/40 bg-emerald-400/8",
  command: "border-slate-400/40 bg-slate-400/8",
  error: "border-red-400/40 bg-red-400/8",
  status_change: "border-muted-foreground/40 bg-muted-foreground/8",
};

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export const SessionTimeline: Component<SessionTimelineProps> = (props) => {
  return (
    <div class="flex flex-col gap-0 relative">
      <Show
        when={props.events.length > 0}
        fallback={
          <div class="flex items-center justify-center py-12 text-muted-foreground text-[13px] opacity-60">
            No events recorded yet
          </div>
        }
      >
        {/* Vertical connector line */}
        <div class="absolute left-[19px] top-4 bottom-4 w-px bg-border/40" />

        <For each={props.events}>
          {(event) => <TimelineEvent event={event} />}
        </For>
      </Show>
    </div>
  );
};

const TimelineEvent: Component<{ event: SessionEvent }> = (props) => {
  const icon = () => EVENT_ICONS[props.event.event_type] ?? "\u25CB";
  const colorClass = () =>
    EVENT_COLORS[props.event.event_type] ?? EVENT_COLORS.status_change;
  const metadata = () => props.event.metadata;

  return (
    <div class="flex gap-3 py-2 px-1 group relative">
      {/* Icon node */}
      <div
        class={`flex-shrink-0 w-[26px] h-[26px] rounded-full border flex items-center justify-center text-[12px] z-10 ${colorClass()}`}
        title={props.event.event_type}
      >
        {icon()}
      </div>

      {/* Content */}
      <div class="flex-1 min-w-0 pt-0.5">
        <div class="flex items-baseline gap-2">
          <span class="text-[13px] font-medium text-foreground truncate">
            {props.event.title}
          </span>
          <span class="text-[11px] text-muted-foreground flex-shrink-0">
            {formatTime(props.event.created_at)}
          </span>
        </div>

        <Show when={props.event.content}>
          <p class="text-[12px] text-muted-foreground mt-0.5 line-clamp-3 leading-relaxed">
            {props.event.content}
          </p>
        </Show>

        {/* Metadata details */}
        <div class="flex items-center gap-2 mt-1 flex-wrap">
          <Show when={metadata()?.url}>
            <span class="text-[11px] text-primary/70 truncate max-w-[240px]">
              {metadata()?.url}
            </span>
          </Show>
          <Show when={metadata()?.tool_name}>
            <span class="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-muted-foreground">
              {metadata()?.tool_name}
            </span>
          </Show>
          <Show when={metadata()?.duration_ms}>
            <span class="text-[11px] text-muted-foreground">
              {formatDuration(metadata()!.duration_ms!)}
            </span>
          </Show>
          <Show
            when={
              props.event.status !== "completed" &&
              props.event.event_type === "approval"
            }
          >
            <span
              class={`text-[11px] px-1.5 py-0.5 rounded font-medium ${
                props.event.status === "pending"
                  ? "bg-amber-500/15 text-amber-400"
                  : props.event.status === "rejected"
                    ? "bg-red-500/15 text-red-400"
                    : "bg-emerald-500/15 text-emerald-400"
              }`}
            >
              {props.event.status}
            </span>
          </Show>
        </div>

        <Show when={metadata()?.error_message}>
          <div class="mt-1 text-[12px] text-red-400 bg-red-500/8 rounded px-2 py-1 border border-red-500/20">
            {metadata()?.error_message}
          </div>
        </Show>
      </div>
    </div>
  );
};
