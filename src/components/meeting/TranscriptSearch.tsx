// ABOUTME: Semantic search field over meeting transcripts with jump-to-meeting results.
// ABOUTME: Calls the transcript-search service; clicking a hit opens its meeting.

import { createSignal, For, Show } from "solid-js";
import {
  searchTranscripts,
  type TranscriptHit,
} from "@/services/transcript-search";
import { meetingStore } from "@/stores/meeting.store";

export function TranscriptSearch() {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<TranscriptHit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searched, setSearched] = createSignal(false);
  const [semanticUnavailable, setSemanticUnavailable] = createSignal(false);

  const run = async () => {
    const trimmed = query().trim();
    if (!trimmed) {
      setHits([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    const result = await searchTranscripts(trimmed, 20);
    setHits(result.hits);
    setSemanticUnavailable(result.semanticUnavailable);
    setSearching(false);
    setSearched(true);
  };

  const meetingTitleFor = (meetingId: string) =>
    meetingStore.state.meetings.find((meeting) => meeting.id === meetingId)
      ?.title ?? "Meeting";

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
          type="search"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search transcripts…"
          class="h-8 w-full rounded-md border border-border bg-surface-1 px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
        />
      </form>

      <Show when={searching()}>
        <div class="mt-2 text-[11px] text-muted-foreground">Searching…</div>
      </Show>

      <Show when={searched() && !searching()}>
        <Show when={semanticUnavailable()}>
          <div class="mt-2 text-[11px] text-warning">
            Semantic search unavailable — showing exact matches.
          </div>
        </Show>
        <Show
          when={hits().length > 0}
          fallback={
            <div class="mt-2 text-[11px] text-muted-foreground">
              No matches.
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
                  <div class="truncate text-[11px] font-medium text-foreground">
                    {meetingTitleFor(hit.meetingId)}
                  </div>
                  <div class="line-clamp-2 whitespace-pre-line text-[11px] text-muted-foreground">
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
