// ABOUTME: Full-pane grouped results view for conversation history search.
// ABOUTME: Shares query/filter state with the spotlight overlay and opens hits in-place.

import { createEffect, createMemo, For, onCleanup, Show } from "solid-js";
import { type HighlightSegment, highlightTerms } from "@/lib/highlight";
import type { ConversationHit } from "@/services/conversation-search";
import { conversationSearchStore } from "@/stores/conversation-search.store";
import { threadStore } from "@/stores/thread.store";

function titleFor(hit: Pick<ConversationHit, "title">): string {
  return hit.title?.trim() || "Untitled conversation";
}

function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const day = 86_400_000;
  if (delta < day) return "today";
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

function FiltersBar() {
  const projects = createMemo(() => {
    const values = new Set<string>();
    for (const thread of threadStore.allConversations) {
      if (thread.projectRoot) values.add(thread.projectRoot);
    }
    return [...values].sort((left, right) => left.localeCompare(right));
  });

  return (
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <div class="inline-flex overflow-hidden rounded-[7px] border border-border">
        <For each={["all", "chat", "agent"] as const}>
          {(kind) => (
            <button
              type="button"
              class={`h-7 px-3 text-[12px] capitalize ${conversationSearchStore.state.filters.kind === kind ? "bg-surface-2 text-foreground" : "text-muted-foreground hover:bg-surface-1 hover:text-foreground"}`}
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
        class="h-7 rounded-[7px] border border-border bg-background px-2 text-[12px] text-secondary-foreground outline-none focus:border-primary/50"
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
        class="h-7 rounded-[7px] border border-border bg-background px-2 text-[12px] text-secondary-foreground outline-none focus:border-primary/50"
      />
      <input
        type="date"
        aria-label="To date"
        value={conversationSearchStore.state.filters.toDate}
        onInput={(event) =>
          conversationSearchStore.setToDate(event.currentTarget.value)
        }
        class="h-7 rounded-[7px] border border-border bg-background px-2 text-[12px] text-secondary-foreground outline-none focus:border-primary/50"
      />
      <label class="flex h-7 items-center gap-2 text-[12px] text-muted-foreground">
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

interface ResultGroup {
  conversationId: string;
  title: string;
  kind: "chat" | "agent";
  agentType: string | null;
  projectRoot: string | null;
  timestamp: number;
  hits: ConversationHit[];
}

export function ConversationSearchResults() {
  let inputRef: HTMLInputElement | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const groups = createMemo(() => {
    const byId = new Map<string, ResultGroup>();
    for (const hit of conversationSearchStore.state.results) {
      const existing = byId.get(hit.conversationId);
      if (existing) {
        existing.hits.push(hit);
        existing.timestamp = Math.max(existing.timestamp, hit.timestamp);
      } else {
        byId.set(hit.conversationId, {
          conversationId: hit.conversationId,
          title: titleFor(hit),
          kind: hit.kind,
          agentType: hit.agentType,
          projectRoot: hit.projectRoot,
          timestamp: hit.timestamp,
          hits: [hit],
        });
      }
    }
    return [...byId.values()];
  });

  createEffect(() => {
    if (conversationSearchStore.state.mode !== "full") return;
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
      conversationSearchStore.state.mode === "full" &&
      conversationSearchStore.state.pendingFocus
    ) {
      queueMicrotask(() => inputRef?.focus());
      conversationSearchStore.consumeFocusRequest();
    }
  });

  onCleanup(() => clearTimeout(debounce));

  return (
    <section
      class="flex h-full min-h-0 flex-col bg-background"
      data-testid="conversation-search-results"
    >
      <div class="shrink-0 border-b border-border px-6 py-4">
        <div class="flex items-center gap-3 rounded-[10px] border border-border-medium bg-surface-1 px-4 py-3 shadow-[0_0_0_3px_rgba(56,189,248,0.08)]">
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
            class="min-w-0 flex-1 bg-transparent text-[18px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            class="rounded p-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            aria-label="Close search"
            onClick={() => conversationSearchStore.close()}
          >
            ×
          </button>
        </div>
        <div class="flex items-start gap-3">
          <FiltersBar />
          <div class="ml-auto mt-4 shrink-0 font-mono text-[12px] text-muted-foreground">
            {conversationSearchStore.state.results.length} matches ·{" "}
            {groups().length} conversations
          </div>
        </div>
      </div>
      <Show when={conversationSearchStore.state.semanticUnavailable}>
        <div class="mx-6 mt-4 flex items-center gap-2 rounded-[8px] border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span aria-hidden="true">△</span>
          <span>
            {conversationSearchStore.state.semanticUnavailableReason
              ? `Semantic search is unavailable: ${conversationSearchStore.state.semanticUnavailableReason}. Showing exact matches only.`
              : "Semantic search is unavailable. Showing exact matches only."}
          </span>
        </div>
      </Show>
      <div class="min-h-0 flex-1 overflow-auto px-6 pb-8 pt-3">
        <Show
          when={conversationSearchStore.state.results.length > 0}
          fallback={
            <div class="flex h-full items-center justify-center text-[13px] text-muted-foreground">
              {conversationSearchStore.state.query.trim()
                ? "No matches."
                : "Search titles, prompts, assistant replies, and agent output."}
            </div>
          }
        >
          <For each={groups()}>
            {(group) => (
              <section class="mt-4">
                <div class="flex min-w-0 items-center gap-2 border-b border-border/60 px-1 pb-2">
                  <KindIcon kind={group.kind} />
                  <button
                    type="button"
                    class="min-w-0 truncate text-left text-[14px] font-semibold text-foreground hover:text-primary"
                    onClick={() =>
                      conversationSearchStore.openHit(group.hits[0])
                    }
                  >
                    {group.title}
                  </button>
                  <span class="truncate text-[12px] text-muted-foreground">
                    · {group.kind === "agent" ? "Agent" : "Chat"}
                    <Show when={group.agentType}>
                      {(agent) => <> · {agent()}</>}
                    </Show>
                    {" · "}
                    {projectLabel(group.projectRoot)} ·{" "}
                    {formatRelativeTime(group.timestamp)}
                  </span>
                  <span class="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                    {group.hits.length}{" "}
                    {group.hits.length === 1 ? "match" : "matches"}
                  </span>
                  <button
                    type="button"
                    class="shrink-0 text-[12px] font-medium text-primary hover:text-primary-hover"
                    onClick={() =>
                      conversationSearchStore.openHit(group.hits[0])
                    }
                  >
                    Open →
                  </button>
                </div>
                <div class="py-1">
                  <For each={group.hits}>
                    {(hit) => (
                      <button
                        type="button"
                        class="flex w-full gap-3 rounded-[8px] px-2 py-2 text-left hover:bg-surface-1"
                        onClick={() => conversationSearchStore.openHit(hit)}
                      >
                        <div class="w-24 shrink-0 pt-0.5 text-right text-[11px] leading-4 text-muted-foreground">
                          <span class="block font-semibold text-secondary-foreground">
                            {roleLabel(hit)}
                          </span>
                          {formatRelativeTime(hit.timestamp)}
                        </div>
                        <div class="min-w-0 flex-1 text-[13px] leading-6 text-secondary-foreground">
                          <HighlightedText
                            text={hit.text}
                            query={conversationSearchStore.state.query}
                          />
                          <Show when={hit.matchType === "semantic"}>
                            <span class="ml-2 text-[11px] text-primary">
                              semantic match
                            </span>
                          </Show>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </div>
    </section>
  );
}
