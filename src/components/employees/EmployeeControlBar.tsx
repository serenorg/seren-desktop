// ABOUTME: Renders the employee's primary run/chat and suspend/wake controls.
// ABOUTME: Keeps control layout and action semantics consistent across modes.

import { type Component, Show } from "solid-js";
import type { EmployeeHealth } from "@/lib/employees/health";
import type { EmployeeSummary } from "@/lib/employees/types";

type EmployeeActionPending = "suspend" | "wake" | "delete" | null;

interface EmployeeControlBarProps {
  employee: EmployeeSummary;
  health: EmployeeHealth;
  isRunning: boolean;
  isWakeable: boolean;
  actionPending: EmployeeActionPending;
  manualRunInFlight: boolean;
  canStartRun: boolean;
  onPrimary: () => void;
  onSuspendOrWake: () => void;
}

function primaryCtaLabel(mode: EmployeeSummary["mode"]): string {
  return mode === "always_on" ? "New conversation" : "Run now";
}

export const EmployeeControlBar: Component<EmployeeControlBarProps> = (
  props,
) => {
  const isAlwaysOn = () => props.employee.mode === "always_on";
  const primaryTitle = () =>
    isAlwaysOn()
      ? `Open a new chat with ${props.employee.name}`
      : `Run ${props.employee.name} once, outside its schedule`;
  const primaryDisabled = () =>
    props.manualRunInFlight ||
    !props.canStartRun ||
    props.actionPending !== null;
  const secondaryLabel = () => (props.isRunning ? "Suspend" : "Wake");
  const secondaryTitle = () =>
    props.isRunning
      ? "Pause scheduled runs. The employee stays deployed and can be woken later."
      : "Redeploy and resume scheduled runs.";

  return (
    <div
      class="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3"
      data-health={props.health}
    >
      <button
        type="button"
        class="inline-flex h-10 min-w-[9rem] items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 text-[13.5px] font-medium text-primary-foreground shadow-sm shadow-primary/20 transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        disabled={primaryDisabled()}
        title={primaryTitle()}
        onClick={props.onPrimary}
      >
        <Show
          when={!props.manualRunInFlight}
          fallback={
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              class="shrink-0 animate-spin"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-dasharray="22 14"
              />
            </svg>
          }
        >
          <Show
            when={isAlwaysOn()}
            fallback={
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                class="shrink-0"
              >
                <path
                  d="M5 4 L12 8 L5 12 Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
              </svg>
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              class="shrink-0"
            >
              <path
                d="M3.5 4.5h9v5.5h-5l-3 2v-2h-1z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
            </svg>
          </Show>
        </Show>
        {props.manualRunInFlight
          ? "Running..."
          : primaryCtaLabel(props.employee.mode)}
      </button>

      <button
        type="button"
        class="rounded-md border px-3.5 py-2 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
        classList={{
          "border-border text-foreground hover:bg-surface-2":
            props.isRunning || !props.isWakeable,
          "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10":
            props.isWakeable && !props.isRunning,
        }}
        disabled={
          props.actionPending !== null ||
          (!props.isRunning && !props.isWakeable)
        }
        title={secondaryTitle()}
        onClick={props.onSuspendOrWake}
      >
        <Show when={props.actionPending === "suspend"}>Suspending...</Show>
        <Show when={props.actionPending === "wake"}>Waking...</Show>
        <Show when={props.actionPending === null}>{secondaryLabel()}</Show>
      </button>

      <Show when={!props.canStartRun}>
        <div class="basis-full text-[12px] text-muted-foreground">
          Wake this employee before starting {isAlwaysOn() ? "a chat" : "a run"}
          .
        </div>
      </Show>
    </div>
  );
};
