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
  // Parent gates this on a resolved org id so the resource fires once with
  // real data rather than firing twice (null then real) and flashing an
  // empty state in between.
  organizationId: string;
  deploymentId: string;
}

const PAGE_SIZE = 25;

/**
 * The resource source is a derived string ("org::dep") rather than an object
 * literal because Solid's createResource compares source values with
 * Object.is: an object literal returns a fresh reference on every memo
 * evaluation, so an upstream invalidation (e.g. the 30s sidebar poll
 * replacing `state.employees`) re-triggers the source memo, produces a new
 * object reference, fails the equality check, and refetches the list - which
 * then tears down every row in the `<For>` because keyed iteration uses
 * identity. A string key collapses identical-input updates to a no-op.
 */
const KEY_SEPARATOR = "::";

function makeKey(org: string, dep: string): string {
  return `${org}${KEY_SEPARATOR}${dep}`;
}

function parseKey(key: string): { org: string; dep: string } {
  const idx = key.indexOf(KEY_SEPARATOR);
  return {
    org: key.slice(0, idx),
    dep: key.slice(idx + KEY_SEPARATOR.length),
  };
}

type CheckpointInitialPage = {
  org: string;
  dep: string;
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
    () => makeKey(props.organizationId, props.deploymentId),
    async (key): Promise<CheckpointInitialPage> => {
      const { org, dep } = parseKey(key);
      // The fetcher only runs when the source key changes (different employee
      // or org), so resetting paged-in extras here is the right moment - it
      // discards the previous deployment's tail without nuking the operator's
      // pagination on a same-key tick.
      setExtras([]);
      setCursor(null);
      const page = await sessionCheckpoints.list(org, dep, {
        limit: PAGE_SIZE,
      });
      setCursor(page.next_cursor ?? null);
      return {
        org,
        dep,
        entries: page.entries,
        next: page.next_cursor ?? null,
      };
    },
  );

  // createResource keeps the previous page in `initial()` while a refetch
  // is in flight (e.g. when the operator switches employees). Guarding the
  // displayed page on org+dep avoids momentarily rendering stale rows from
  // the previous deployment.
  const visibleInitial = () => {
    const page = initial();
    if (!page) return null;
    if (page.org !== props.organizationId || page.dep !== props.deploymentId) {
      return null;
    }
    return page;
  };

  const all = () => [...(visibleInitial()?.entries ?? []), ...extras()];
  const shouldShowLoading = () => initial.loading && visibleInitial() === null;
  const shouldShowEmpty = () =>
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
        <Match when={shouldShowLoading()}>
          {/* Skeleton rows reserve the same vertical space the loaded list
              will occupy so the body doesn't jump when checkpoints arrive. */}
          <div
            class="relative rounded-md border border-border bg-card overflow-hidden animate-pulse"
            role="status"
            aria-label="Loading checkpoints"
          >
            <For each={[0, 1, 2]}>
              {(i) => (
                <div
                  class="relative pl-9 pr-3 py-3"
                  classList={{ "border-b border-border/40": i !== 2 }}
                >
                  <span
                    class="absolute left-[11px] top-[14px] w-[9px] h-[9px] rounded-full border border-border bg-surface-2"
                    aria-hidden="true"
                  />
                  <div class="flex items-baseline gap-3">
                    <div class="h-[11px] w-32 rounded bg-muted/40" />
                    <div class="ml-auto h-[11px] w-20 rounded bg-muted/30" />
                  </div>
                  <div class="mt-2 h-[10px] w-2/3 rounded bg-muted/30" />
                </div>
              )}
            </For>
          </div>
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
