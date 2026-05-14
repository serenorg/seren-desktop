// ABOUTME: Cursor-paginated list of session checkpoints written by an employee's agent runtime.
// ABOUTME: Read-only timeline; agents author checkpoints. Operators inspect session/sequence/reason here.

import {
  type Component,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { formatRelativeTime } from "@/lib/employees/relative-time";
import {
  type SessionCheckpoint,
  sessionCheckpoints,
} from "@/services/session-checkpoints";

interface EmployeeCheckpointsListProps {
  organizationId: string | null;
  deploymentId: string;
}

const PAGE_SIZE = 25;

type CheckpointResourceKey = {
  org: string;
  dep: string;
};

type CheckpointInitialPage = CheckpointResourceKey & {
  entries: SessionCheckpoint[];
  next: string | null;
};

const CheckpointRow: Component<{
  row: SessionCheckpoint;
  first: boolean;
  last: boolean;
}> = (props) => (
  <div
    class="relative pl-9 pr-3 py-3 group"
    data-checkpoint-id={props.row.checkpoint_id}
  >
    {/* Rail segment above this row, hidden on the first row. */}
    <Show when={!props.first}>
      <span
        class="absolute left-[15px] top-0 h-3 w-px bg-border/50"
        aria-hidden="true"
      />
    </Show>
    {/* Rail segment below this row, hidden on the last row. */}
    <Show when={!props.last}>
      <span
        class="absolute left-[15px] top-[24px] bottom-0 w-px bg-border/50"
        aria-hidden="true"
      />
    </Show>
    {/* Node on the rail. */}
    <span
      class="absolute left-[11px] top-[14px] w-[9px] h-[9px] rounded-full border border-border bg-surface-2 transition-colors group-hover:border-primary/60 group-hover:bg-primary/20"
      aria-hidden="true"
    />
    <div class="flex items-baseline gap-3 flex-wrap min-w-0">
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="font-mono text-[11.5px] text-foreground tracking-tight">
          {props.row.session_id.slice(0, 12)}
        </span>
        <span class="text-muted-foreground/40 text-[11px]">/</span>
        <span class="font-mono text-[11.5px] tabular-nums text-muted-foreground">
          #{props.row.sequence_number}
        </span>
      </div>
      <div class="ml-auto flex items-center gap-2 text-[10.5px] text-muted-foreground/80 tabular-nums whitespace-nowrap">
        <span class="px-1.5 py-px rounded bg-surface-2/40 ring-1 ring-inset ring-border/60">
          iter {props.row.iteration_count}
        </span>
        <span title={props.row.created_at}>
          {formatRelativeTime(props.row.created_at)}
        </span>
      </div>
    </div>
    <div
      class="mt-1 text-[12px] text-muted-foreground/90 truncate"
      title={props.row.reason}
    >
      {props.row.reason}
    </div>
  </div>
);

const EmptyState: Component = () => (
  <div class="flex items-start gap-3 px-1 py-1">
    <div
      class="relative shrink-0 mt-0.5 w-8 h-8 rounded-md border border-border/60 bg-surface-2/30 flex items-center justify-center"
      aria-hidden="true"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        class="text-muted-foreground/60"
      >
        <circle
          cx="8"
          cy="8"
          r="5.5"
          stroke="currentColor"
          stroke-width="1.2"
        />
        <path
          d="M8 5v3l2 1.5"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
        />
      </svg>
    </div>
    <div class="min-w-0">
      <div class="text-[12.5px] font-medium text-foreground/90">
        No checkpoints yet
      </div>
      <div class="text-[11.5px] text-muted-foreground/80 mt-0.5">
        Agents write a checkpoint each time they pause for approval or hit an
        iteration cap.
      </div>
    </div>
  </div>
);

export const EmployeeCheckpointsList: Component<
  EmployeeCheckpointsListProps
> = (props) => {
  const [extras, setExtras] = createSignal<SessionCheckpoint[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [loadMoreError, setLoadMoreError] = createSignal<string | null>(null);

  const [initial] = createResource(
    (): CheckpointResourceKey | null => {
      if (props.organizationId === null) return null;
      return { org: props.organizationId, dep: props.deploymentId };
    },
    async (keys): Promise<CheckpointInitialPage> => {
      setExtras([]);
      const page = await sessionCheckpoints.list(keys.org, keys.dep, {
        limit: PAGE_SIZE,
      });
      setCursor(page.next_cursor ?? null);
      return {
        org: keys.org,
        dep: keys.dep,
        entries: page.entries,
        next: page.next_cursor ?? null,
      };
    },
  );

  const visibleInitial = () => {
    const page = initial();
    if (!page) return null;
    if (page.org !== props.organizationId || page.dep !== props.deploymentId) {
      return null;
    }
    return page;
  };

  const all = () => [...(visibleInitial()?.entries ?? []), ...extras()];
  const shouldShowLoading = () =>
    props.organizationId !== null &&
    initial.loading &&
    visibleInitial() === null;
  const shouldShowEmpty = () =>
    props.organizationId !== null &&
    !initial.loading &&
    !initial.error &&
    visibleInitial() !== null &&
    all().length === 0;
  const hasMore = () => visibleInitial() !== null && cursor() !== null;

  const handleLoadMore = async () => {
    const org = props.organizationId;
    const next = cursor();
    if (!org || !next || initial.loading || loadingMore()) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await sessionCheckpoints.list(org, props.deploymentId, {
        limit: PAGE_SIZE,
        cursor: next,
      });
      setExtras((prev) => [...prev, ...page.entries]);
      setCursor(page.next_cursor ?? null);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section aria-label="Session checkpoints">
      <Switch>
        <Match when={props.organizationId === null}>
          <div class="min-h-11" aria-hidden="true" />
        </Match>
        <Match when={shouldShowLoading()}>
          <div class="min-h-11" aria-hidden="true" />
        </Match>
        <Match when={initial.error}>
          <div
            class="rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive"
            role="alert"
          >
            {initial.error instanceof Error
              ? initial.error.message
              : String(initial.error)}
          </div>
        </Match>
        <Match when={shouldShowEmpty()}>
          <EmptyState />
        </Match>
        <Match when={all().length > 0}>
          <div class="relative rounded-md border border-border bg-card overflow-hidden">
            <For each={all()}>
              {(row, index) => (
                <CheckpointRow
                  row={row}
                  first={index() === 0}
                  last={index() === all().length - 1}
                />
              )}
            </For>
          </div>
        </Match>
      </Switch>
      <Show when={loadMoreError()}>
        <div
          class="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive"
          role="alert"
        >
          {loadMoreError()}
        </div>
      </Show>
      <Show when={hasMore()}>
        <div class="mt-2 flex justify-center">
          <button
            type="button"
            class="py-1.5 px-3 rounded text-[12px] font-medium bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            onClick={() => void handleLoadMore()}
            disabled={loadingMore()}
            data-testid="checkpoints-load-more"
          >
            {loadingMore() ? "Loading..." : "Load more"}
          </button>
        </div>
      </Show>
    </section>
  );
};
