// ABOUTME: Compact card comparing the latest eval-run pass/fail counts to the apply baseline.
// ABOUTME: Shows deltas with directional arrows; empty state when the gate has no baseline.

import { type Component, createResource, Match, Show, Switch } from "solid-js";
import { formatDriftDelta } from "@/lib/employees/eval-drift-format";
import {
  type CloudDeploymentEvalDrift,
  getEvalDrift,
} from "@/services/eval-drift";

interface EmployeeEvalDriftCardProps {
  organizationId: string | null;
  deploymentId: string;
}

const ChannelCell: Component<{
  label: string;
  current: number | null | undefined;
  baseline: number | null | undefined;
  delta: number | null | undefined;
  // `lowerIsBetter` flips the colour for a delta whose direction is undesirable.
  lowerIsBetter: boolean;
}> = (props) => {
  const formatted = () => formatDriftDelta(props.delta, props.lowerIsBetter);
  return (
    <div class="flex flex-col gap-0.5 min-w-0">
      <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
        {props.label}
      </div>
      <div class="text-[15px] font-semibold text-foreground tabular-nums">
        <Show
          when={typeof props.current === "number"}
          fallback={<span>-</span>}
        >
          {props.current}
        </Show>
        <Show when={typeof props.baseline === "number"}>
          <span class="text-[11px] font-normal text-muted-foreground ml-1.5">
            (was {props.baseline})
          </span>
        </Show>
      </div>
      <Show when={formatted()}>
        {(label) => (
          <div
            class="text-[11px] font-medium tabular-nums"
            classList={{
              "text-emerald-400": label().tone === "good",
              "text-amber-300": label().tone === "warn",
              "text-muted-foreground": label().tone === "neutral",
            }}
          >
            {label().text}
          </div>
        )}
      </Show>
    </div>
  );
};

export const EmployeeEvalDriftCard: Component<EmployeeEvalDriftCardProps> = (
  props,
) => {
  const [drift] = createResource(
    () => ({ org: props.organizationId, dep: props.deploymentId }),
    async (keys: {
      org: string | null;
      dep: string;
    }): Promise<CloudDeploymentEvalDrift | null> => {
      if (!keys.org) return null;
      return await getEvalDrift(keys.org, keys.dep);
    },
  );

  const baseline = () => drift()?.baseline ?? null;
  const hasCurrent = () =>
    typeof drift()?.current_passed === "number" ||
    typeof drift()?.current_failed === "number";

  return (
    <div class="border border-border rounded-md px-4 py-3 bg-card">
      <div class="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <div class="text-[12px] font-semibold text-foreground">
            Eval drift
          </div>
          <div class="text-[11px] text-muted-foreground">
            Last run vs apply baseline
          </div>
        </div>
        <Show when={drift()?.current_run_id}>
          {(runId) => (
            <span
              class="font-mono text-[10.5px] text-muted-foreground truncate max-w-[140px]"
              title={runId()}
            >
              {runId().slice(0, 12)}
            </span>
          )}
        </Show>
      </div>
      <Switch>
        <Match when={drift.loading}>
          <div class="text-[12px] text-muted-foreground" role="status">
            Loading eval drift...
          </div>
        </Match>
        <Match when={drift.error}>
          <div
            class="rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive"
            role="alert"
          >
            {drift.error instanceof Error
              ? drift.error.message
              : String(drift.error)}
          </div>
        </Match>
        <Match when={drift() && !baseline()}>
          <div class="text-[12px] text-muted-foreground">
            {drift()?.message ?? "No apply baseline recorded yet."}
          </div>
        </Match>
        <Match when={drift() && baseline() && !hasCurrent()}>
          <div class="text-[12px] text-muted-foreground">
            {drift()?.message ?? "Baseline recorded; no run yet."}
          </div>
        </Match>
        <Match when={drift() && baseline() && hasCurrent()}>
          <div class="grid grid-cols-2 gap-3">
            <ChannelCell
              label="Passed"
              current={drift()?.current_passed}
              baseline={baseline()?.baseline_passed}
              delta={drift()?.passed_delta}
              lowerIsBetter={false}
            />
            <ChannelCell
              label="Failed"
              current={drift()?.current_failed}
              baseline={baseline()?.baseline_failed}
              delta={drift()?.failed_delta}
              lowerIsBetter={true}
            />
          </div>
          <Show when={drift()?.message}>
            {(msg) => (
              <div class="mt-2 text-[11px] text-muted-foreground">{msg()}</div>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  );
};
