// ABOUTME: Meeting detail "notes canvas": rendered notes, template picker, regenerate, transcript.
// ABOUTME: AI notes render muted; transcript shows Me bright / Them muted with jump-to-source.

import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import {
  formatDuration,
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
import { meetingStore } from "@/stores/meeting.store";
import { settingsStore } from "@/stores/settings.store";

interface MeetingDetailProps {
  meeting: Meeting;
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

  const rows = new Map<number, HTMLElement>();

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
    <div class="p-5 max-w-[760px]">
      <div class="mb-5">
        <h3 class="text-[18px] font-semibold tracking-normal">
          {meetingTitle(props.meeting)}
        </h3>
        <div class="mt-1 flex items-center gap-3 text-[12px] text-muted-foreground">
          <span>{STATUS_LABELS[props.meeting.status]}</span>
          <span class="font-mono tabular-nums">
            {formatDuration(props.meeting)}
          </span>
          <span>{props.meeting.sourceApp ?? "Desktop"}</span>
        </div>
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
                  class="grid grid-cols-[52px_1fr] gap-3 py-2 border-b border-border/50 last:border-b-0 transition-colors"
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
                    class="text-[13px] leading-5"
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
