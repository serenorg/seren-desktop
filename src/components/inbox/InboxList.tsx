// ABOUTME: Unified approval inbox UI - lists ToolCall and BlockedEgress entries by group.
// ABOUTME: Approve/Deny actions go through ConfirmDialog before calling the approval-inbox service.

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { ConfirmDialog } from "@/components/catalog/ConfirmDialog";
import { groupInboxEntries } from "@/components/inbox/grouping";
import { getDefaultOrganizationId } from "@/lib/tauri-bridge";
import {
  type ApprovalDecisionState,
  type ApprovalDecisionVerb,
  type ApprovalInboxBlockedEgressEntry,
  type ApprovalInboxEntry,
  ApprovalInboxNotImplementedError,
  type ApprovalInboxToolCallEntry,
  approvalInbox,
} from "@/services/approval-inbox";

function intendedTerminalState(
  decision: ApprovalDecisionVerb,
): ApprovalDecisionState {
  return decision === "approve" ? "approved" : "denied";
}

const DECISION_LABEL: Record<ApprovalDecisionState, string> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
};

/**
 * Compact relative timestamps tuned for an at-a-glance inbox scan: a single
 * unit + suffix per row ("30s", "5m", "1h", "3d") rather than a full prose
 * phrase. Falls back to a locale date once the entry is more than a week old.
 */
function relativeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return new Date(iso).toLocaleDateString();
}

function decisionBadgeClass(state: ApprovalDecisionState): string {
  switch (state) {
    case "pending":
      return "bg-amber-500/15 text-amber-200 border border-amber-500/40";
    case "approved":
      return "bg-emerald-500/15 text-emerald-200 border border-emerald-500/40";
    case "denied":
      return "bg-red-500/15 text-red-200 border border-red-500/40";
    case "expired":
      return "bg-slate-500/15 text-slate-300 border border-slate-500/40";
  }
}

interface PendingDecision {
  entryId: string;
  decision: ApprovalDecisionVerb;
}

function toolCallTitle(entry: ApprovalInboxToolCallEntry): string {
  return entry.tool_ref || "Tool call";
}

function toolCallSummary(entry: ApprovalInboxToolCallEntry): string {
  const parts: string[] = [];
  if (entry.function_call_id) parts.push(`call ${entry.function_call_id}`);
  parts.push(`run ${entry.run_id.slice(0, 8)}`);
  if (entry.reason) parts.push(entry.reason);
  return parts.join(" - ");
}

function blockedEgressTitle(entry: ApprovalInboxBlockedEgressEntry): string {
  return `${entry.host}:${entry.port}`;
}

function blockedEgressSummary(entry: ApprovalInboxBlockedEgressEntry): string {
  const parts: string[] = [];
  if (entry.method) parts.push(entry.method);
  if (entry.path) parts.push(entry.path);
  if (entry.reason) parts.push(entry.reason);
  return parts.length > 0 ? parts.join(" - ") : "Network egress blocked";
}

const EntryRow: Component<{
  entry: ApprovalInboxEntry;
  onDecide: (entryId: string, decision: ApprovalDecisionVerb) => void;
  busyEntryId: string | null;
}> = (props) => {
  const isTerminal = () => props.entry.decision_state !== "pending";
  const isBusy = () => props.busyEntryId === props.entry.entry_id;

  const title = (): string => {
    if (props.entry.kind === "tool_call") return toolCallTitle(props.entry);
    if (props.entry.kind === "blocked_egress")
      return blockedEgressTitle(props.entry);
    return props.entry.subkind;
  };
  const summary = (): string => {
    if (props.entry.kind === "tool_call") return toolCallSummary(props.entry);
    if (props.entry.kind === "blocked_egress")
      return blockedEgressSummary(props.entry);
    return props.entry.reason ?? "Awaiting operator review";
  };

  return (
    <div
      class="flex flex-col gap-2 rounded-lg border border-border bg-surface-1/40 px-4 py-3"
      data-testid="inbox-entry"
      data-entry-id={props.entry.entry_id}
      data-entry-kind={props.entry.kind}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-[13px] font-medium text-foreground truncate">
            {title()}
          </div>
          <div class="text-[12px] text-muted-foreground truncate">
            {summary()}
          </div>
          <div
            class="text-[11px] text-muted-foreground/70 mt-0.5 tabular-nums"
            title={props.entry.created_at}
          >
            {relativeAge(props.entry.created_at)}
          </div>
        </div>
        <span
          class={`text-[10px] uppercase tracking-[0.08em] font-semibold px-2 py-1 rounded-full whitespace-nowrap ${decisionBadgeClass(props.entry.decision_state)}`}
          data-testid="inbox-entry-state"
        >
          {DECISION_LABEL[props.entry.decision_state]}
        </span>
      </div>
      <Show when={!isTerminal()}>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="py-1.5 px-3 rounded text-[12px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => props.onDecide(props.entry.entry_id, "deny")}
            disabled={isBusy()}
            data-testid="inbox-deny"
          >
            Deny
          </button>
          <button
            type="button"
            class="py-1.5 px-3 rounded text-[12px] font-medium cursor-pointer transition-all duration-150 bg-primary text-primary-foreground border border-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => props.onDecide(props.entry.entry_id, "approve")}
            disabled={isBusy()}
            data-testid="inbox-approve"
          >
            Approve
          </button>
        </div>
      </Show>
    </div>
  );
};

const EmptyState: Component = () => (
  <div
    class="flex flex-col items-center justify-center text-center py-20 px-6 text-muted-foreground"
    role="status"
  >
    <div class="relative mb-4" aria-hidden="true">
      {/* Soft emerald halo behind the check so "all clear" reads as a real
          steady state, not an empty-bordered placeholder. */}
      <div class="absolute inset-0 -m-3 rounded-full bg-emerald-500/[0.08] blur-xl" />
      <div class="relative w-14 h-14 rounded-full border border-emerald-500/30 bg-emerald-500/[0.06] flex items-center justify-center">
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
          class="text-emerald-400"
        >
          <path
            d="M4.5 10.5 L8.25 14 L15.5 6.5"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
    </div>
    <div class="text-[13.5px] font-medium text-foreground/90">All clear</div>
    <div class="text-[12px] text-muted-foreground/70 mt-1 max-w-[280px] leading-relaxed">
      Operator decisions land here as agents request them.
    </div>
  </div>
);

const SkeletonRow: Component = () => (
  <div
    class="flex flex-col gap-2 rounded-lg border border-border/60 bg-surface-1/30 px-4 py-3 animate-pulse"
    aria-hidden="true"
  >
    <div class="h-3 w-1/3 bg-muted/60 rounded" />
    <div class="h-3 w-2/3 bg-muted/40 rounded" />
    <div class="h-3 w-1/4 bg-muted/30 rounded" />
  </div>
);

export const InboxList: Component = () => {
  const [orgId, setOrgId] = createSignal<string | null>(null);
  const [extraEntries, setExtraEntries] = createSignal<ApprovalInboxEntry[]>(
    [],
  );
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [loadMoreError, setLoadMoreError] = createSignal<string | null>(null);
  const [pendingDecision, setPendingDecision] =
    createSignal<PendingDecision | null>(null);
  const [busyEntryId, setBusyEntryId] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [refreshNonce, setRefreshNonce] = createSignal(0);
  // Optimistic post-decision overrides keyed by entry_id. Lets us reflect a
  // resolved decision_state without forcing a full refetch and dropping any
  // pages the operator paged in.
  const [decisionOverrides, setDecisionOverrides] = createSignal<
    Record<string, ApprovalDecisionState>
  >({});

  const applyOverrides = (entries: ApprovalInboxEntry[]) => {
    const overrides = decisionOverrides();
    if (Object.keys(overrides).length === 0) return entries;
    return entries.map((entry) => {
      const next = overrides[entry.entry_id];
      return next ? { ...entry, decision_state: next } : entry;
    });
  };

  const [initialPage] = createResource(
    () => refreshNonce(),
    async () => {
      const id = await getDefaultOrganizationId();
      setOrgId(id);
      if (!id) return { entries: [] as ApprovalInboxEntry[], next: null };
      const page = await approvalInbox.list(id, { limit: 50 });
      setCursor(page.next_cursor ?? null);
      setExtraEntries([]);
      return {
        entries: page.entries,
        next: page.next_cursor ?? null,
      };
    },
  );

  const allEntries = createMemo<ApprovalInboxEntry[]>(() => {
    const first = initialPage()?.entries ?? [];
    return applyOverrides([...first, ...extraEntries()]);
  });

  const grouped = createMemo(() => groupInboxEntries(allEntries()));

  const hasMore = () => !initialPage.loading && cursor() !== null;

  const refresh = () => {
    // A manual refresh discards optimistic overrides; the server is now the
    // source of truth again. Also clears any stale notice/error from a prior
    // decision so the operator gets a clean slate on the new page.
    setNotice(null);
    setActionError(null);
    setLoadMoreError(null);
    setDecisionOverrides({});
    setRefreshNonce((n) => n + 1);
  };

  const handleLoadMore = async () => {
    const id = orgId();
    const next = cursor();
    if (!id || !next || loadingMore()) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await approvalInbox.list(id, { limit: 50, cursor: next });
      setExtraEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.next_cursor ?? null);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleDecideRequest = (
    entryId: string,
    decision: ApprovalDecisionVerb,
  ) => {
    setPendingDecision({ entryId, decision });
  };

  const handleCancelDecision = () => {
    if (busyEntryId()) return;
    setPendingDecision(null);
  };

  const recordOverride = (entryId: string, state: ApprovalDecisionState) => {
    setDecisionOverrides((prev) => ({ ...prev, [entryId]: state }));
  };

  const handleConfirmDecision = async () => {
    const pending = pendingDecision();
    const id = orgId();
    if (!pending || !id) return;
    setBusyEntryId(pending.entryId);
    setActionError(null);
    setNotice(null);
    try {
      const result = await approvalInbox.decide(id, pending.entryId, {
        decision: pending.decision,
      });
      recordOverride(pending.entryId, result.decision_state);
      setPendingDecision(null);
      setNotice(
        pending.decision === "approve"
          ? "Approval recorded."
          : "Denial recorded.",
      );
    } catch (err) {
      if (err instanceof ApprovalInboxNotImplementedError) {
        // The 501 path means the audit row was written upstream; we still flip
        // the local row so the operator does not re-click it endlessly.
        recordOverride(err.entryId, intendedTerminalState(pending.decision));
        setPendingDecision(null);
        setNotice(err.message);
      } else {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusyEntryId(null);
    }
  };

  return (
    <section
      class="flex flex-col h-full overflow-auto px-6 py-5"
      aria-label="Approval inbox"
    >
      <header class="flex items-baseline justify-between mb-4">
        <div>
          <h1 class="m-0 text-[18px] font-semibold text-foreground">
            Approval inbox
          </h1>
          <p class="m-0 mt-0.5 text-[12px] text-muted-foreground">
            Operator decisions awaiting your review.
          </p>
        </div>
        <button
          type="button"
          class="py-1.5 px-3 rounded text-[12px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted"
          onClick={refresh}
          data-testid="inbox-refresh"
        >
          Refresh
        </button>
      </header>

      <Show when={notice()}>
        <div
          class="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100"
          role="status"
        >
          {notice()}
        </div>
      </Show>
      <Show when={actionError()}>
        <div
          class="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-100"
          role="alert"
        >
          {actionError()}
        </div>
      </Show>

      <Switch>
        <Match when={initialPage.loading}>
          <div class="flex flex-col gap-2">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        </Match>
        <Match when={initialPage.error}>
          <div
            class="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-100"
            role="alert"
          >
            {initialPage.error instanceof Error
              ? initialPage.error.message
              : String(initialPage.error)}
          </div>
        </Match>
        <Match when={allEntries().length === 0}>
          <EmptyState />
        </Match>
        <Match when={allEntries().length > 0}>
          <div class="flex flex-col gap-6">
            <Show when={grouped().toolCalls.length > 0}>
              <div data-testid="inbox-group-tool-call">
                <h2 class="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground/80 mb-2">
                  Tool approval
                </h2>
                <div class="flex flex-col gap-2">
                  <For each={grouped().toolCalls}>
                    {(entry) => (
                      <EntryRow
                        entry={entry}
                        onDecide={handleDecideRequest}
                        busyEntryId={busyEntryId()}
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={grouped().blockedEgress.length > 0}>
              <div data-testid="inbox-group-blocked-egress">
                <h2 class="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground/80 mb-2">
                  Network egress
                </h2>
                <div class="flex flex-col gap-2">
                  <For each={grouped().blockedEgress}>
                    {(entry) => (
                      <EntryRow
                        entry={entry}
                        onDecide={handleDecideRequest}
                        busyEntryId={busyEntryId()}
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={grouped().other.length > 0}>
              <div data-testid="inbox-group-other">
                <h2 class="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted-foreground/80 mb-2">
                  Other
                </h2>
                <div class="flex flex-col gap-2">
                  <For each={grouped().other}>
                    {(entry) => (
                      <EntryRow
                        entry={entry}
                        onDecide={handleDecideRequest}
                        busyEntryId={busyEntryId()}
                      />
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </Match>
      </Switch>

      <Show when={loadMoreError()}>
        <div
          class="mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-100"
          role="alert"
        >
          {loadMoreError()}
        </div>
      </Show>

      <div class="mt-4">
        <Show
          when={hasMore()}
          fallback={
            <Show when={!initialPage.loading && allEntries().length > 0}>
              <div class="text-center text-[11px] text-muted-foreground/70 py-3">
                End of inbox
              </div>
            </Show>
          }
        >
          <div class="flex justify-center">
            <button
              type="button"
              class="py-1.5 px-4 rounded text-[12px] font-medium cursor-pointer transition-all duration-150 bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => void handleLoadMore()}
              disabled={loadingMore()}
              data-testid="inbox-load-more"
            >
              {loadingMore() ? "Loading..." : "Load more"}
            </button>
          </div>
        </Show>
      </div>

      <ConfirmDialog
        open={pendingDecision() !== null}
        title={
          pendingDecision()?.decision === "approve"
            ? "Approve entry?"
            : "Deny entry?"
        }
        message={
          pendingDecision()?.decision === "approve"
            ? "This authorizes the request to proceed. The decision is auditable."
            : "This denies the request. The decision is auditable."
        }
        confirmLabel={
          pendingDecision()?.decision === "approve" ? "Approve" : "Deny"
        }
        destructive={pendingDecision()?.decision === "deny"}
        pending={busyEntryId() !== null}
        onConfirm={() => void handleConfirmDecision()}
        onCancel={handleCancelDecision}
      />
    </section>
  );
};
