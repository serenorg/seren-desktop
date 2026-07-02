// ABOUTME: Spotlight overlay for searching chat and agent conversation history.
// ABOUTME: Renders exact and semantic hits with keyboard navigation and safe highlights.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { type HighlightSegment, highlightTerms } from "@/lib/highlight";
import type { ConversationHit } from "@/services/conversation-search";
import {
  type ConversationKindFilter,
  conversationSearchStore,
} from "@/stores/conversation-search.store";
import { threadStore } from "@/stores/thread.store";

function titleFor(hit: ConversationHit): string {
  return hit.title?.trim() || "Untitled conversation";
}

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))}m ago`;
  if (delta < day) return `${Math.round(delta / hour)}h ago`;
  if (delta < 14 * day) return `${Math.round(delta / day)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function roleLabel(hit: ConversationHit): string {
  if (hit.role === "user") return "You";
  return hit.agentType || "Assistant";
}

function projectLabel(projectRoot: string | null): string {
  if (!projectRoot) return "No project";
  return projectRoot.split("/").filter(Boolean).at(-1) || projectRoot;
}

function KindIcon(props: { kind: "chat" | "agent" }) {
  return (
    <svg
      class={`h-4 w-4 shrink-0 ${props.kind === "agent" ? "text-violet-300" : "text-muted-foreground"}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Show
        when={props.kind === "agent"}
        fallback={
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
        }
      >
        <path d="m12 2 8 4.7v10.6L12 22l-8-4.7V6.7z" />
      </Show>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      class="h-5 w-5 shrink-0 text-muted-foreground"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

function HighlightedText(props: { text: string; query: string }) {
  const segments = createMemo(() => highlightTerms(props.text, props.query));
  return (
    <For each={segments()}>
      {(segment: HighlightSegment) =>
        typeof segment === "string" ? (
          segment
        ) : (
          <mark class="rounded bg-primary/15 px-0.5 font-semibold text-primary">
            {segment.mark}
          </mark>
        )
      }
    </For>
  );
}

function ResultRow(props: {
  hit: ConversationHit;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      class={`relative w-full rounded-[7px] border px-3 py-2 text-left transition-colors ${props.selected ? "border-border bg-surface-2 before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0.5 before:rounded before:bg-primary" : "border-transparent hover:bg-surface-0"}`}
      onClick={props.onOpen}
    >
      <div class="flex min-w-0 items-center gap-2">
        <KindIcon kind={props.hit.kind} />
        <div class="min-w-0 truncate text-[13px] font-semibold text-foreground">
          {titleFor(props.hit)}
        </div>
        <div class="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {formatRelativeTime(props.hit.timestamp)}
        </div>
      </div>
      <div class="ml-6 mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11px] text-muted-foreground">
        <span>{props.hit.kind === "agent" ? "Agent" : "Chat"}</span>
        <Show when={props.hit.agentType}>
          {(agent) => (
            <>
              <span>·</span>
              <span>{agent()}</span>
            </>
          )}
        </Show>
        <span>·</span>
        <span>{projectLabel(props.hit.projectRoot)}</span>
        <Show when={props.hit.matchType === "semantic"}>
          <span>·</span>
          <span class="text-primary">semantic match</span>
        </Show>
      </div>
      <div class="ml-6 mt-1 line-clamp-2 text-[12px] leading-5 text-secondary-foreground">
        <span class="font-semibold text-muted-foreground">
          {roleLabel(props.hit)}:
        </span>{" "}
        <HighlightedText
          text={props.hit.text}
          query={conversationSearchStore.state.query}
        />
      </div>
    </button>
  );
}

function SearchFilters() {
  const projects = createMemo(() => {
    const values = new Set<string>();
    for (const thread of threadStore.allConversations) {
      if (thread.projectRoot) values.add(thread.projectRoot);
    }
    return [...values].sort((left, right) => left.localeCompare(right));
  });

  return (
    <div class="flex flex-wrap items-center gap-2 border-b border-border/60 bg-surface-0 px-3 py-2">
      <div class="inline-flex overflow-hidden rounded-[7px] border border-border">
        <For each={["all", "chat", "agent"] as ConversationKindFilter[]}>
          {(kind) => (
            <button
              type="button"
              class={`h-7 px-3 text-[12px] capitalize transition-colors ${conversationSearchStore.state.filters.kind === kind ? "bg-surface-2 text-foreground" : "text-muted-foreground hover:bg-surface-1 hover:text-foreground"}`}
              onClick={() => conversationSearchStore.setKind(kind)}
            >
              {kind}
            </button>
          )}
        </For>
      </div>
      <select
        aria-label="Project"
        value={conversationSearchStore.state.filters.projectRoot ?? ""}
        onChange={(event) =>
          conversationSearchStore.setProjectRoot(
            event.currentTarget.value || null,
          )
        }
        class="h-7 rounded-[7px] border border-border bg-surface-0 px-2 text-[12px] text-secondary-foreground outline-none focus:border-primary/50"
      >
        <option value="">All projects</option>
        <For each={projects()}>
          {(project) => (
            <option value={project}>{projectLabel(project)}</option>
          )}
        </For>
      </select>
      <input
        type="date"
        aria-label="From date"
        value={conversationSearchStore.state.filters.fromDate}
        onInput={(event) =>
          conversationSearchStore.setFromDate(event.currentTarget.value)
        }
        class="h-7 rounded-[7px] border border-border bg-surface-0 px-2 text-[12px] text-secondary-foreground outline-none focus:border-primary/50"
      />
      <input
        type="date"
        aria-label="To date"
        value={conversationSearchStore.state.filters.toDate}
        onInput={(event) =>
          conversationSearchStore.setToDate(event.currentTarget.value)
        }
        class="h-7 rounded-[7px] border border-border bg-surface-0 px-2 text-[12px] text-secondary-foreground outline-none focus:border-primary/50"
      />
      <label class="ml-auto flex h-7 items-center gap-2 text-[12px] text-muted-foreground">
        <input
          type="checkbox"
          checked={conversationSearchStore.state.filters.includeArchived}
          onChange={(event) =>
            conversationSearchStore.setIncludeArchived(
              event.currentTarget.checked,
            )
          }
          class="h-3.5 w-3.5 accent-primary"
        />
        Include archived
      </label>
    </div>
  );
}

export function ConversationSearchOverlay() {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const visibleResults = createMemo(() =>
    conversationSearchStore.state.results.slice(0, 8),
  );
  const exactResults = createMemo(() =>
    visibleResults().filter((hit) => hit.matchType === "exact"),
  );
  const semanticResults = createMemo(() =>
    visibleResults().filter((hit) => hit.matchType === "semantic"),
  );
  const selectableCount = () =>
    visibleResults().length +
    (conversationSearchStore.state.results.length > 0 ? 1 : 0);

  createEffect(() => {
    if (!conversationSearchStore.state.open) return;
    conversationSearchStore.state.query;
    const filters = conversationSearchStore.state.filters;
    filters.kind;
    filters.projectRoot;
    filters.fromDate;
    filters.toDate;
    filters.includeArchived;
    clearTimeout(debounce);
    debounce = setTimeout(() => void conversationSearchStore.runSearch(), 150);
  });

  createEffect(() => {
    if (
      conversationSearchStore.state.open &&
      conversationSearchStore.state.pendingFocus
    ) {
      queueMicrotask(() => inputRef?.focus());
      conversationSearchStore.consumeFocusRequest();
    }
  });

  createEffect(() => {
    if (selectedIndex() >= selectableCount()) setSelectedIndex(0);
  });

  onCleanup(() => clearTimeout(debounce));

  const openSelected = () => {
    const selected = selectedIndex();
    if (selected < visibleResults().length) {
      conversationSearchStore.openHit(visibleResults()[selected]);
    } else if (conversationSearchStore.state.results.length > 0) {
      conversationSearchStore.expandToFull();
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      conversationSearchStore.close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((value) => (value + 1) % Math.max(selectableCount(), 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex(
        (value) =>
          (value - 1 + Math.max(selectableCount(), 1)) %
          Math.max(selectableCount(), 1),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openSelected();
    }
  };

  return (
    <Show when={conversationSearchStore.state.open}>
      <div
        class="fixed inset-0 z-50 bg-background/70 backdrop-blur-[2px]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget)
            conversationSearchStore.close();
        }}
      >
        <section
          role="dialog"
          aria-label="Search conversation history"
          data-testid="conversation-search-overlay"
          class="absolute left-1/2 top-[11vh] flex max-h-[74vh] w-[680px] max-w-[calc(100vw-40px)] -translate-x-1/2 flex-col overflow-hidden rounded-[12px] border border-border-strong bg-surface-1 shadow-[0_24px_70px_rgba(0,0,0,0.62),0_4px_14px_rgba(0,0,0,0.45)]"
          onKeyDown={handleKeyDown}
        >
          <div class="flex items-center gap-3 border-b border-border px-4 py-3.5">
            <SearchIcon />
            <input
              ref={inputRef}
              type="search"
              spellcheck={false}
              value={conversationSearchStore.state.query}
              onInput={(event) =>
                conversationSearchStore.setQuery(event.currentTarget.value)
              }
              placeholder="Search history"
              data-testid="conversation-search-input"
              class="min-w-0 flex-1 bg-transparent text-[17px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            <kbd class="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              Esc
            </kbd>
          </div>
          <SearchFilters />
          <Show when={conversationSearchStore.state.semanticUnavailable}>
            <div class="mx-3 mt-3 rounded-[8px] border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
              {conversationSearchStore.state.semanticUnavailableReason
                ? `Semantic search unavailable: ${conversationSearchStore.state.semanticUnavailableReason}. Showing exact matches.`
                : "Semantic search unavailable. Showing exact matches."}
            </div>
          </Show>
          <div class="min-h-[160px] overflow-auto px-1.5 py-2">
            <Show
              when={conversationSearchStore.state.query.trim()}
              fallback={
                <div class="px-3 py-10 text-center text-[13px] text-muted-foreground">
                  Search titles, prompts, assistant replies, and agent output.
                </div>
              }
            >
              <Show
                when={
                  conversationSearchStore.state.loading ||
                  conversationSearchStore.state.results.length > 0
                }
                fallback={
                  <div class="px-3 py-10 text-center text-[13px] text-muted-foreground">
                    {conversationSearchStore.state.searched
                      ? "No matches."
                      : "Type to search history."}
                  </div>
                }
              >
                <Show when={conversationSearchStore.state.loading}>
                  <div class="px-3 pb-2 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    Searching
                  </div>
                </Show>
                <Show when={exactResults().length > 0}>
                  <div class="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {conversationSearchStore.state.results.length} results
                  </div>
                  <For each={exactResults()}>
                    {(hit, index) => (
                      <ResultRow
                        hit={hit}
                        selected={selectedIndex() === index()}
                        onOpen={() => conversationSearchStore.openHit(hit)}
                      />
                    )}
                  </For>
                </Show>
                <Show when={semanticResults().length > 0}>
                  <div class="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Related by meaning
                  </div>
                  <For each={semanticResults()}>
                    {(hit, index) => (
                      <ResultRow
                        hit={hit}
                        selected={
                          selectedIndex() === exactResults().length + index()
                        }
                        onOpen={() => conversationSearchStore.openHit(hit)}
                      />
                    )}
                  </For>
                </Show>
                <Show when={conversationSearchStore.state.results.length > 0}>
                  <button
                    type="button"
                    class={`mt-1 flex h-9 w-full items-center justify-between rounded-[7px] px-3 text-left text-[12px] transition-colors ${selectedIndex() === visibleResults().length ? "bg-surface-2 text-foreground" : "text-muted-foreground hover:bg-surface-0 hover:text-foreground"}`}
                    onClick={() => conversationSearchStore.expandToFull()}
                  >
                    <span>
                      See all {conversationSearchStore.state.results.length}{" "}
                      results
                    </span>
                    <span aria-hidden="true">→</span>
                  </button>
                </Show>
              </Show>
            </Show>
          </div>
          <div class="flex items-center gap-4 border-t border-border bg-surface-0 px-3 py-2 text-[11px] text-muted-foreground">
            <span>↑↓ Navigate</span>
            <span>↵ Open</span>
            <span>Esc Close</span>
            <span class="ml-auto">
              {conversationSearchStore.state.semanticUnavailable
                ? "Exact only"
                : "Exact + semantic"}
            </span>
          </div>
        </section>
      </div>
    </Show>
  );
}
