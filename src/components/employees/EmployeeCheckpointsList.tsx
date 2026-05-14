// ABOUTME: Cursor-paginated list of session checkpoints written by an employee's agent runtime.
// ABOUTME: Read-only; agents author checkpoints. Operators inspect session/sequence/reason here.

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

const CheckpointRow: Component<{ row: SessionCheckpoint }> = (props) => (
  <div
    class="grid grid-cols-[1fr_auto_auto] gap-3 items-baseline px-3 py-2 border-b border-border last:border-b-0"
    data-checkpoint-id={props.row.checkpoint_id}
  >
    <div class="min-w-0">
      <div class="text-[12.5px] text-foreground truncate">
        <span class="font-mono text-[11.5px] text-muted-foreground">
          {props.row.session_id.slice(0, 12)}
        </span>
        <span class="mx-1.5 text-muted-foreground/60">/</span>
        <span class="tabular-nums">#{props.row.sequence_number}</span>
      </div>
      <div
        class="text-[11.5px] text-muted-foreground truncate"
        title={props.row.reason}
      >
        {props.row.reason}
      </div>
    </div>
    <div class="text-[11.5px] text-muted-foreground tabular-nums whitespace-nowrap">
      iter {props.row.iteration_count}
    </div>
    <div
      class="text-[11.5px] text-muted-foreground whitespace-nowrap"
      title={props.row.created_at}
    >
      {formatRelativeTime(props.row.created_at)}
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
    () => {
      const org = props.organizationId;
      if (!org) return null;
      return { org, dep: props.deploymentId };
    },
    async (keys: { org: string; dep: string }) => {
      setExtras([]);
      const page = await sessionCheckpoints.list(keys.org, keys.dep, {
        limit: PAGE_SIZE,
      });
      setCursor(page.next_cursor ?? null);
      return { entries: page.entries, next: page.next_cursor ?? null };
    },
  );

  const all = () => [...(initial()?.entries ?? []), ...extras()];

  const handleLoadMore = async () => {
    const org = props.organizationId;
    const next = cursor();
    if (!org || !next || loadingMore()) return;
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
        <Match
          when={
            (props.organizationId === null || initial.loading) && !initial()
          }
        >
          <div class="text-[12px] text-muted-foreground" role="status">
            Loading checkpoints...
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
        <Match when={all().length === 0}>
          <div class="text-[12px] text-muted-foreground italic">
            No checkpoints yet. Agents write a checkpoint each time they pause
            for approval or hit an iteration cap.
          </div>
        </Match>
        <Match when={all().length > 0}>
          <div class="border border-border rounded-md bg-card">
            <For each={all()}>{(row) => <CheckpointRow row={row} />}</For>
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
      <Show when={cursor() !== null}>
        <div class="mt-2 flex justify-center">
          <button
            type="button"
            class="py-1.5 px-3 rounded text-[12px] font-medium bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
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
