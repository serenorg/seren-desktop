// ABOUTME: Compact card comparing the latest eval-run pass/fail counts to the apply baseline.
// ABOUTME: Trend-tinted accent edge plus tabular delta glyphs let operators read drift at a glance.

import {
  type Component,
  createMemo,
  createResource,
  Match,
  Show,
  Switch,
} from "solid-js";
import { formatDriftDelta } from "@/lib/employees/eval-drift-format";
import {
  type CloudDeploymentEvalDrift,
  getEvalDrift,
} from "@/services/eval-drift";

interface EmployeeEvalDriftCardProps {
  organizationId: string | null;
  deploymentId: string;
}

type Trend = "improving" | "regressing" | "neutral";

function overallTrend(drift: CloudDeploymentEvalDrift | undefined): Trend {
  if (!drift) return "neutral";
  const passed = drift.passed_delta;
  const failed = drift.failed_delta;
  const regressing =
    (typeof passed === "number" && passed < 0) ||
    (typeof failed === "number" && failed > 0);
  if (regressing) return "regressing";
  const improving =
    (typeof passed === "number" && passed > 0) ||
    (typeof failed === "number" && failed < 0);
  if (improving) return "improving";
  return "neutral";
}

const ArrowGlyph: Component<{ direction: "up" | "down" | "flat" }> = (
  props,
) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 10 10"
    fill="none"
    aria-hidden="true"
    class="shrink-0"
  >
    <Show when={props.direction === "up"}>
      <path
        d="M5 2 L8 6 L6.4 6 L6.4 8 L3.6 8 L3.6 6 L2 6 Z"
        fill="currentColor"
      />
    </Show>
    <Show when={props.direction === "down"}>
      <path
        d="M5 8 L2 4 L3.6 4 L3.6 2 L6.4 2 L6.4 4 L8 4 Z"
        fill="currentColor"
      />
    </Show>
    <Show when={props.direction === "flat"}>
      <path
        d="M2.5 5 L7.5 5"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </Show>
  </svg>
);

const DeltaBadge: Component<{
  delta: number | null | undefined;
  lowerIsBetter: boolean;
}> = (props) => {
  const formatted = () => formatDriftDelta(props.delta, props.lowerIsBetter);
  const direction = (): "up" | "down" | "flat" => {
    if (typeof props.delta !== "number" || props.delta === 0) return "flat";
    return props.delta > 0 ? "up" : "down";
  };
  return (
    <Show when={formatted()}>
      {(label) => (
        <span
          class="inline-flex items-center gap-1 px-1.5 py-px rounded text-[10px] font-medium tabular-nums leading-[1.4]"
          classList={{
            "bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/25":
              label().tone === "good",
            "bg-amber-500/10 text-amber-200 ring-1 ring-inset ring-amber-500/30":
              label().tone === "warn",
            "bg-surface-2/60 text-muted-foreground ring-1 ring-inset ring-border":
              label().tone === "neutral",
          }}
          aria-label={`Delta ${label().text}`}
        >
          <ArrowGlyph direction={direction()} />
          {typeof props.delta === "number" ? Math.abs(props.delta) : 0}
        </span>
      )}
    </Show>
  );
};

const ChannelCell: Component<{
  label: string;
  current: number | null | undefined;
  baseline: number | null | undefined;
  delta: number | null | undefined;
  lowerIsBetter: boolean;
}> = (props) => (
  <div class="flex flex-col gap-1.5 min-w-0">
    <div class="flex items-center gap-2 min-h-[18px]">
      <span class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
        {props.label}
      </span>
      <DeltaBadge delta={props.delta} lowerIsBetter={props.lowerIsBetter} />
    </div>
    <div class="flex items-baseline gap-2 flex-wrap">
      <span class="text-[28px] font-semibold tabular-nums leading-none text-foreground tracking-tight">
        <Show
          when={typeof props.current === "number"}
          fallback={<span class="text-muted-foreground/40">-</span>}
        >
          {props.current}
        </Show>
      </span>
      <Show when={typeof props.baseline === "number"}>
        <span class="text-[11px] tabular-nums text-muted-foreground/70 whitespace-nowrap">
          <span class="text-muted-foreground/40">from</span> {props.baseline}
        </span>
      </Show>
    </div>
  </div>
);

const EmptyState: Component<{ title: string; detail: string }> = (props) => (
  <div class="flex items-start gap-3 py-1">
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
        <path
          d="M2.5 12.5 L5.5 8.5 L8 10.5 L13 4"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle cx="13" cy="4" r="1" fill="currentColor" />
      </svg>
    </div>
    <div class="min-w-0">
      <div class="text-[12.5px] font-medium text-foreground/90">
        {props.title}
      </div>
      <div class="text-[11.5px] text-muted-foreground/80 mt-0.5">
        {props.detail}
      </div>
    </div>
  </div>
);

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
  const trend = createMemo<Trend>(() => overallTrend(drift() ?? undefined));

  return (
    <div class="relative overflow-hidden rounded-lg border border-border bg-card">
      {/* Trend-tinted accent stripe along the leading edge. */}
      <div
        class="absolute inset-y-0 left-0 w-[2px] transition-colors duration-300"
        classList={{
          "bg-emerald-400/70": trend() === "improving",
          "bg-amber-400/70": trend() === "regressing",
          "bg-border/80": trend() === "neutral",
        }}
        aria-hidden="true"
      />
      <div class="px-5 py-4 pl-[22px]">
        <div class="flex items-start justify-between gap-3 mb-4">
          <div class="min-w-0">
            <div class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
              Eval drift
            </div>
            <div class="mt-0.5 text-[12.5px] text-foreground/85">
              Last run vs apply baseline
            </div>
          </div>
          <Show when={drift()?.current_run_id}>
            {(runId) => (
              <span
                class="font-mono text-[10.5px] tracking-tight text-muted-foreground/80 px-1.5 py-0.5 rounded bg-surface-2/40 ring-1 ring-inset ring-border/60 truncate max-w-[160px]"
                title={runId()}
              >
                {runId().slice(0, 8)}
              </span>
            )}
          </Show>
        </div>
        <Switch>
          <Match when={drift.loading}>
            <div
              class="flex items-center gap-2 text-[12px] text-muted-foreground"
              role="status"
            >
              <span
                class="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-pulse"
                aria-hidden="true"
              />
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
            <EmptyState
              title="No baseline captured"
              detail={
                drift()?.message ??
                "Apply a passing eval run to capture the first baseline."
              }
            />
          </Match>
          <Match when={drift() && baseline() && !hasCurrent()}>
            <EmptyState
              title="Baseline ready"
              detail={
                drift()?.message ??
                "Run the eval set to see drift against the baseline."
              }
            />
          </Match>
          <Match when={drift() && baseline() && hasCurrent()}>
            <div class="grid grid-cols-2 gap-6">
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
                <div class="mt-3 pt-3 border-t border-border/40 text-[11.5px] text-muted-foreground/80 leading-relaxed">
                  {msg()}
                </div>
              )}
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
};
