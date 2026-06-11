// ABOUTME: Meeting detail "notes canvas": rendered notes, template picker, regenerate, transcript.
// ABOUTME: AI notes render muted; transcript shows Me bright / Them muted with jump-to-source.

import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { openExternalLink } from "@/lib/external-link";
import {
  formatDuration,
  formatMeetingDate,
  formatTime,
  meetingTitle,
  STATUS_LABELS,
} from "@/lib/meeting-format";
import { renderMarkdown } from "@/lib/render-markdown";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import {
  listMeetingTemplates,
  type Meeting,
  type MeetingTemplate,
  type StructuredNotes,
  type TranscriptSegment,
} from "@/services/meetings";
import { authStore, requestSignInModal } from "@/stores/auth.store";
import { meetingStore } from "@/stores/meeting.store";
import { settingsStore } from "@/stores/settings.store";

interface MeetingDetailProps {
  meeting: Meeting;
  onRequestDelete?: (meeting: Meeting) => void;
}

function PencilGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M11.1 2.9a1.2 1.2 0 0 1 1.7 1.7l-6.8 6.8-2.3.6.6-2.3 6.8-6.8Z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6.2 2.5h3.6M3.5 4.5h9M5 4.5l.4 8.2c.1.6.5.9 1.1.9h3c.6 0 1-.3 1.1-.9l.4-8.2M6.9 6.7v4.5M9.1 6.7v4.5"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function parseStructured(json: string | null): StructuredNotes | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<StructuredNotes>;
    return {
      summary: parsed.summary ?? "",
      actionItems: parsed.actionItems ?? [],
      fields: parsed.fields ?? {},
    };
  } catch {
    return null;
  }
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "and",
  "of",
  "for",
  "on",
  "in",
  "with",
  "we",
  "i",
  "you",
  "is",
  "are",
  "will",
]);

function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

export function MeetingDetail(props: MeetingDetailProps) {
  const [templates, setTemplates] = createSignal<MeetingTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = createSignal(
    props.meeting.templateId ?? settingsStore.get("meetingTemplateId"),
  );
  const [regenerating, setRegenerating] = createSignal(false);
  const [highlightedSeq, setHighlightedSeq] = createSignal<number | null>(null);
  const [editingTitle, setEditingTitle] = createSignal(false);
  const [titleDraft, setTitleDraft] = createSignal("");

  const rows = new Map<number, HTMLElement>();

  const startEditingTitle = () => {
    // Edit the raw stored title (blank for an auto-named meeting), not the
    // "Meeting HH:MM:SS" fallback, so the placeholder guides a real name.
    setTitleDraft(props.meeting.title);
    setEditingTitle(true);
  };

  // Persist the draft, then leave edit mode. Guarded so Enter (which exits edit
  // mode) and the unmount blur that follows don't both fire a rename.
  const commitTitle = async () => {
    if (!editingTitle()) return;
    const draft = titleDraft();
    setEditingTitle(false);
    await meetingStore.renameMeeting(props.meeting, draft);
  };

  onMount(async () => {
    let builtins: MeetingTemplate[] = [];
    try {
      builtins = await listMeetingTemplates();
    } catch {
      builtins = [];
    }
    setTemplates([...builtins, ...settingsStore.get("meetingCustomTemplates")]);
  });

  const structured = createMemo(() =>
    parseStructured(props.meeting.notesStructJson),
  );

  const segments = () => meetingStore.state.liveSegments;
  const deleteDisabled = () =>
    props.meeting.status === "pending_capture" ||
    props.meeting.status === "capturing" ||
    props.meeting.status === "transcribing" ||
    props.meeting.status === "agent_running";

  const jumpToSource = (text: string) => {
    const target = keywords(text);
    if (target.length === 0) return;
    let best: TranscriptSegment | null = null;
    let bestScore = 0;
    for (const segment of segments()) {
      if (segment.status !== "ok") continue;
      const words = new Set(keywords(segment.text));
      const score = target.reduce((acc, k) => acc + (words.has(k) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = segment;
      }
    }
    if (best && bestScore > 0) {
      setHighlightedSeq(best.seq);
      rows
        .get(best.seq)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const regenerate = async () => {
    if (regenerating()) return;
    setRegenerating(true);
    try {
      await meetingStore.regenerateNotes(props.meeting, selectedTemplate());
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div class="p-5 max-w-none">
      <div class="mb-5">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <Show
              when={editingTitle()}
              fallback={
                <div class="group flex max-w-full items-center gap-1.5">
                  <h3 class="truncate text-[18px] font-semibold tracking-normal">
                    {meetingTitle(props.meeting)}
                  </h3>
                  <button
                    type="button"
                    class="shrink-0 rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-70"
                    onClick={startEditingTitle}
                    title="Rename meeting"
                    aria-label="Rename meeting"
                  >
                    <PencilGlyph />
                  </button>
                </div>
              }
            >
              <input
                ref={(el) => queueMicrotask(() => el.focus())}
                class="w-full h-9 rounded-md border border-border bg-surface-1 px-2.5 text-[18px] font-semibold text-foreground focus:outline-none focus:border-primary/60"
                value={titleDraft()}
                placeholder={meetingTitle(props.meeting)}
                aria-label="Meeting title"
                onInput={(event) => setTitleDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitTitle();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setEditingTitle(false);
                  }
                }}
                onBlur={() => void commitTitle()}
              />
            </Show>
            <div class="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
              <span>{STATUS_LABELS[props.meeting.status]}</span>
              <span class="font-mono tabular-nums">
                {formatDuration(props.meeting)}
              </span>
              <span>
                {formatMeetingDate(props.meeting.startedAt)} ·{" "}
                {formatTime(props.meeting.startedAt)}
              </span>
              <span>{props.meeting.sourceApp ?? "Desktop"}</span>
            </div>
          </div>
          <button
            type="button"
            class="h-8 w-8 shrink-0 flex items-center justify-center rounded-md border border-destructive/35 bg-destructive/10 text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-45 disabled:cursor-not-allowed"
            onClick={() => props.onRequestDelete?.(props.meeting)}
            disabled={deleteDisabled()}
            title={
              deleteDisabled()
                ? "Stop capture before deleting"
                : "Delete meeting"
            }
            aria-label="Delete meeting"
          >
            <TrashGlyph />
          </button>
        </div>
        <Show when={props.meeting.failureReason}>
          {(reason) => (
            <div
              class="mt-3 rounded-md border p-3 text-[12px] leading-5"
              classList={{
                "border-destructive/30 bg-destructive/10 text-destructive":
                  props.meeting.status === "failed",
                "border-warning/30 bg-warning/10 text-warning":
                  props.meeting.status !== "failed",
              }}
            >
              {reason()}
            </div>
          )}
        </Show>
      </div>

      <div class="mb-4 flex items-center gap-2">
        <span class="text-[12px] text-muted-foreground">Templates</span>
        <select
          class="h-7 rounded-md border border-border bg-surface-1 px-2 text-[12px] text-foreground focus:outline-none focus:border-primary/60"
          value={selectedTemplate()}
          onChange={(event) => setSelectedTemplate(event.currentTarget.value)}
        >
          <For each={templates()}>
            {(template) => <option value={template.id}>{template.name}</option>}
          </For>
        </select>
        <button
          type="button"
          class="h-7 px-2.5 rounded-md border border-primary/40 bg-primary/10 text-[12px] text-primary hover:bg-primary/15 disabled:opacity-60"
          onClick={regenerate}
          disabled={regenerating() || !isTauriRuntime()}
          title="Regenerate notes with the selected template"
        >
          {regenerating() ? "Regenerating…" : "Regenerate"}
        </button>
      </div>

      <section class="mb-6">
        <div class="mb-2 text-[12px] font-medium text-muted-foreground">
          Notes
        </div>
        <Show
          when={props.meeting.notesMarkdown}
          fallback={
            <div class="min-h-[88px] rounded-md border border-border bg-surface-0/50 p-3 text-[13px] text-muted-foreground">
              Notes will appear here after capture.
            </div>
          }
        >
          {(markdown) => (
            <div
              class="meeting-notes rounded-md border border-border bg-surface-0/50 p-3 text-[13px] leading-6 text-muted-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_strong]:text-foreground"
              innerHTML={renderMarkdown(markdown())}
            />
          )}
        </Show>
        <Show when={props.meeting.notesMarkdown}>
          <Show
            when={props.meeting.serenNotesId}
            fallback={
              <Show when={!authStore.isAuthenticated}>
                <div class="mt-2 text-[12px] text-muted-foreground">
                  <button
                    type="button"
                    class="text-primary hover:underline focus:outline-none focus:underline"
                    onClick={() => requestSignInModal()}
                  >
                    Login to SerenDB to chat with your meeting notes
                  </button>
                </div>
              </Show>
            }
          >
            {(serenNotesId) => {
              const url = `https://notes.serendb.com/notes/${serenNotesId()}`;
              return (
                <div class="mt-2 text-[12px] text-muted-foreground">
                  Chat with meeting notes:{" "}
                  <button
                    type="button"
                    class="text-primary hover:underline focus:outline-none focus:underline break-all"
                    onClick={() => {
                      void openExternalLink(url);
                    }}
                    title="Open this meeting on notes.serendb.com"
                  >
                    {url}
                  </button>
                </div>
              );
            }}
          </Show>
        </Show>
      </section>

      <Show when={structured()?.actionItems.length}>
        <section class="mb-6">
          <div class="mb-2 text-[12px] font-medium text-muted-foreground">
            Action items
          </div>
          <ul class="space-y-1">
            <For each={structured()?.actionItems ?? []}>
              {(item) => (
                <li>
                  <button
                    type="button"
                    class="text-left w-full text-[13px] text-foreground hover:text-primary flex items-start gap-2"
                    onClick={() => jumpToSource(item)}
                    title="Jump to the related transcript moment"
                  >
                    <span class="text-primary/70 mt-0.5">⌕</span>
                    <span>{item}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>

      <section>
        <div class="mb-2 text-[12px] font-medium text-muted-foreground">
          Transcript
        </div>
        <Show
          when={segments().length > 0}
          fallback={
            <div class="rounded-md border border-border bg-surface-0/50 p-3 text-[13px] text-muted-foreground">
              No transcript yet.
            </div>
          }
        >
          <div class="rounded-md border border-border bg-surface-0/50 px-3">
            <For each={segments()}>
              {(segment) => (
                <div
                  ref={(el) => rows.set(segment.seq, el)}
                  class="grid grid-cols-[64px_minmax(0,1fr)] gap-3 py-2 border-b border-border/50 last:border-b-0 transition-colors"
                  classList={{
                    "bg-primary/10": highlightedSeq() === segment.seq,
                  }}
                >
                  <div
                    class="text-[11px] font-mono tabular-nums"
                    classList={{
                      "text-foreground": segment.speaker === "me",
                      "text-muted-foreground": segment.speaker === "them",
                    }}
                  >
                    {segment.speaker === "me" ? "Me" : "Them"}
                  </div>
                  <div
                    class="min-w-0 break-words text-[13px] leading-5"
                    classList={{
                      "text-muted-foreground italic": segment.status === "gap",
                      "text-foreground": segment.status === "ok",
                    }}
                  >
                    {segment.status === "gap" ? "Transcript gap" : segment.text}
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}
