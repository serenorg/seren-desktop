// ABOUTME: Semantic search field over meeting transcripts with jump-to-meeting results.
// ABOUTME: Calls the transcript-search service; clicking a hit opens its meeting.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { formatMeetingDate, formatTime } from "@/lib/meeting-format";
import {
  searchTranscripts,
  type TranscriptHit,
} from "@/services/transcript-search";
import { meetingStore } from "@/stores/meeting.store";

function dayStartMs(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : undefined;
}

function dayEndMs(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(`${value}T23:59:59.999`);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : undefined;
}

function attendeesFor(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function TranscriptSearch() {
  const [query, setQuery] = createSignal("");
  const [speaker, setSpeaker] = createSignal<"all" | "me" | "them">("all");
  const [fromDate, setFromDate] = createSignal("");
  const [toDate, setToDate] = createSignal("");
  const [attendee, setAttendee] = createSignal("");
  const [hits, setHits] = createSignal<TranscriptHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searched, setSearched] = createSignal(false);
  const [semanticUnavailable, setSemanticUnavailable] = createSignal(false);
  const [semanticUnavailableReason, setSemanticUnavailableReason] =
    createSignal<string | null>(null);
  let inputRef: HTMLInputElement | undefined;

  const knownAttendees = createMemo(() => {
    const values = new Set<string>();
    for (const meeting of meetingStore.state.meetings) {
      for (const item of attendeesFor(meeting.attendeesJson)) {
        const trimmed = item.trim();
        if (trimmed) values.add(trimmed);
      }
    }
    return [...values].sort((left, right) => left.localeCompare(right));
  });

  const hasFilters = () =>
    Boolean(speaker() !== "all" || fromDate() || toDate() || attendee().trim());

  const run = async (nextQuery = query()) => {
    const trimmed = nextQuery.trim();
    if (!trimmed) {
      setHits([]);
      setSearched(false);
      setSemanticUnavailable(false);
      setSemanticUnavailableReason(null);
      return;
    }
    setSearching(true);
    const result = await searchTranscripts(trimmed, {
      limit: 20,
      meetings: meetingStore.state.meetings,
      filters: {
        speaker: speaker(),
        startedAfterMs: dayStartMs(fromDate()),
        startedBeforeMs: dayEndMs(toDate()),
        attendee: attendee(),
      },
    });
    setHits(result.hits);
    setSemanticUnavailable(result.semanticUnavailable);
    setSemanticUnavailableReason(result.semanticUnavailableReason ?? null);
    setSearching(false);
    setSearched(true);
  };

  // The global shortcut and `/transcripts` slash command open this panel and
  // ask the input to focus. A slash command can also provide the initial query.
  createEffect(() => {
    const pendingQuery = meetingStore.state.pendingSearchQuery;
    if (meetingStore.state.pendingSearchFocus) {
      inputRef?.focus();
      meetingStore.clearSearchFocus();
    }
    if (pendingQuery !== null) {
      setQuery(pendingQuery);
      meetingStore.clearSearchQuery();
      if (pendingQuery.trim()) {
        queueMicrotask(() => void run(pendingQuery));
      }
    }
  });

  const meetingFor = (meetingId: string) =>
    meetingStore.state.meetings.find((meeting) => meeting.id === meetingId);

  const meetingTitleFor = (meetingId: string) =>
    meetingFor(meetingId)?.title ?? "Meeting";

  const meetingDateFor = (meetingId: string) => {
    const meeting = meetingFor(meetingId);
    return meeting
      ? `${formatMeetingDate(meeting.startedAt)} · ${formatTime(meeting.startedAt)}`
      : "";
  };

  const openHit = (hit: TranscriptHit) => {
    const meeting = meetingStore.state.meetings.find(
      (item) => item.id === hit.meetingId,
    );
    if (meeting) {
      void meetingStore.setActiveMeeting(meeting);
      meetingStore.requestSegmentScroll(hit.meetingId, hit.seqStart);
    }
  };

  return (
    <div class="border-b border-border bg-surface-0/40 px-4 py-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          ref={inputRef}
          type="search"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search transcripts…"
          class="h-8 w-full rounded-md border border-border bg-surface-1 px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
        />

        <div class="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label="Speaker"
            value={speaker()}
            onChange={(event) =>
              setSpeaker(event.currentTarget.value as "all" | "me" | "them")
            }
            class="h-7 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-foreground focus:border-primary/50 focus:outline-none"
          >
            <option value="all">Any speaker</option>
            <option value="me">Me</option>
            <option value="them">Them</option>
          </select>
          <input
            type="date"
            aria-label="From date"
            value={fromDate()}
            onInput={(event) => setFromDate(event.currentTarget.value)}
            class="h-7 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-foreground focus:border-primary/50 focus:outline-none"
          />
          <input
            type="date"
            aria-label="To date"
            value={toDate()}
            onInput={(event) => setToDate(event.currentTarget.value)}
            class="h-7 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-foreground focus:border-primary/50 focus:outline-none"
          />
          <input
            type="search"
            aria-label="Attendee"
            value={attendee()}
            list="transcript-search-attendees"
            onInput={(event) => setAttendee(event.currentTarget.value)}
            placeholder="Attendee"
            class="h-7 min-w-[130px] flex-1 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
          />
          <datalist id="transcript-search-attendees">
            <For each={knownAttendees()}>
              {(item) => <option value={item} />}
            </For>
          </datalist>
          <button
            type="submit"
            class="h-7 rounded-md border border-primary/40 bg-primary/10 px-2.5 text-[11px] text-primary transition-colors hover:bg-primary/15 disabled:opacity-60"
            disabled={searching()}
          >
            Search
          </button>
          <Show when={hasFilters()}>
            <button
              type="button"
              class="h-7 rounded-md border border-border bg-surface-1 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
              onClick={() => {
                setSpeaker("all");
                setFromDate("");
                setToDate("");
                setAttendee("");
              }}
            >
              Clear
            </button>
          </Show>
        </div>
      </form>

      <Show when={searching()}>
        <div class="mt-2 text-[11px] text-muted-foreground">Searching…</div>
      </Show>

      <Show when={searched() && !searching()}>
        <Show when={semanticUnavailable()}>
          <div class="mt-2 text-[11px] text-warning">
            {semanticUnavailableReason()
              ? `Semantic search unavailable: ${semanticUnavailableReason()} — showing exact matches.`
              : "Semantic search unavailable — showing exact matches."}
          </div>
        </Show>
        <Show
          when={hits().length > 0}
          fallback={
            <div class="mt-2 text-[11px] text-muted-foreground">
              {hasFilters() ? "No matches for these filters." : "No matches."}
            </div>
          }
        >
          <div class="mt-2 flex max-h-48 flex-col gap-1.5 overflow-auto">
            <For each={hits()}>
              {(hit) => (
                <button
                  type="button"
                  onClick={() => openHit(hit)}
                  class="rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2"
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="truncate text-[11px] font-medium text-foreground">
                      {meetingTitleFor(hit.meetingId)}
                    </div>
                    <div class="shrink-0 text-[10px] text-muted-foreground">
                      {meetingDateFor(hit.meetingId)}
                    </div>
                  </div>
                  <div class="mt-1 line-clamp-4 whitespace-pre-line text-[11px] leading-4 text-muted-foreground">
                    {hit.text}
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
