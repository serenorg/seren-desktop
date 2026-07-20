// ABOUTME: Presents employee spend as a compact three-cell operator summary.
// ABOUTME: Keeps cost fetches fail-soft so detail rendering remains available.

import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  type JSX,
  onCleanup,
  untrack,
  Show,
} from "solid-js";
import {
  formatMicrosUsd,
  nextSpendPollDelayMs,
  sumRunCostMicros,
  windowStartIso,
} from "@/lib/employees/spend";
import type { EmployeeRun } from "@/lib/employees/types";
import { employees as svc } from "@/services/employees";

interface EmployeeCostSummaryProps {
  employeeId: string;
  refreshNonce: number;
}

const CostCell: Component<{ label: string; children: JSX.Element }> = (
  props,
) => (
  <div class="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
    <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
      {props.label}
    </div>
    <div class="mt-1 text-[13px] text-foreground truncate">
      {props.children}
    </div>
  </div>
);

export const EmployeeCostSummary: Component<EmployeeCostSummaryProps> = (
  props,
) => {
  const [spendAttempt, setSpendAttempt] = createSignal(0);
  const spendResourceKey = () =>
    `${props.employeeId}::${props.refreshNonce}::${spendAttempt()}`;
  const recentResourceKey = () => `${props.employeeId}::${props.refreshNonce}`;
  const [spend] = createResource(spendResourceKey, async (key) => {
    const [employeeId] = key.split("::");
    return svc.getSpend(employeeId);
  });
  const [recentSpend] = createResource(recentResourceKey, async (key) => {
    const [employeeId] = key.split("::");
    return svc.listRunsSince(employeeId, windowStartIso(Date.now(), 30));
  });

  let convergedRunCount: number | null = null;
  const [baselineRunCount, setBaselineRunCount] = createSignal<number | null>(
    null,
  );
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let seenNonce: number | null = null;

  const clearPollTimer = () => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  createEffect(() => {
    const nonce = props.refreshNonce;
    if (seenNonce === null) {
      seenNonce = nonce;
      return;
    }
    if (nonce === seenNonce) return;
    seenNonce = nonce;
    setBaselineRunCount(convergedRunCount);
    setSpendAttempt(0);
    clearPollTimer();
  });

  createEffect(() => {
    props.employeeId;
    convergedRunCount = null;
    setBaselineRunCount(null);
    setSpendAttempt(0);
    clearPollTimer();
  });

  createEffect(() => {
    const total = spend();
    const attempt = spendAttempt();
    if (!total || spend.loading) return;

    const baseline = untrack(baselineRunCount);
    if (baseline === null) {
      convergedRunCount = total.runCount;
      clearPollTimer();
      return;
    }

    const delay = nextSpendPollDelayMs(attempt, baseline, total.runCount);
    clearPollTimer();
    if (delay === null) {
      convergedRunCount = total.runCount;
      setBaselineRunCount(null);
      return;
    }

    pollTimer = setTimeout(() => {
      pollTimer = null;
      setSpendAttempt((current) => current + 1);
    }, delay);
  });

  onCleanup(clearPollTimer);

  const sortedRuns = createMemo(() => {
    const rows = recentSpend()?.rows ?? [];
    return [...rows].sort(
      (left, right) =>
        new Date(right.startedAt).getTime() -
        new Date(left.startedAt).getTime(),
    );
  });
  const hasError = () => Boolean(spend.error || recentSpend.error);
  const spendUpdating = () =>
    baselineRunCount() !== null && !spend.error && !recentSpend.error;
  const lastRun = (): EmployeeRun | undefined => sortedRuns()[0];
  const lastRunCost = () => {
    const run = lastRun();
    return run
      ? formatMicrosUsd(run.inferenceCostAtomic + run.computeCostAtomic)
      : "—";
  };
  const sinceLaunchCost = () => {
    const total = spend();
    return total
      ? `${formatMicrosUsd(total.totalMicros)} · ${total.runCount} runs`
      : "—";
  };

  return (
    <div
      class="border-b border-border px-6"
      data-testid="employee-cost-summary"
    >
      <Show
        when={!hasError()}
        fallback={
          <div class="py-3 text-[12px] text-muted-foreground">
            Costs unavailable
          </div>
        }
      >
        <div class="grid grid-cols-3 divide-x divide-border">
          <CostCell label="Last run">{lastRunCost()}</CostCell>
          <CostCell label="Last 30 days">
            {formatMicrosUsd(sumRunCostMicros(recentSpend()?.rows ?? []))}
            {" · "}
            {recentSpend()?.rows.length ?? 0} runs
            <Show when={recentSpend()?.truncated}> (partial)</Show>
          </CostCell>
          <CostCell label="Since launch">
            {sinceLaunchCost()}
            <Show when={spendUpdating()}>
              <span class="text-muted-foreground"> · updating…</span>
            </Show>
          </CostCell>
        </div>
      </Show>
    </div>
  );
};
