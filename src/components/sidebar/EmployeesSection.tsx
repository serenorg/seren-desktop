// ABOUTME: Sidebar section listing virtual employees (deployed seren-agent workers).
// ABOUTME: Shows status dots, supports click-to-open-detail, exposes a New employee button.

import {
  type Component,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { CreateEmployeeModal } from "@/components/sidebar/CreateEmployeeModal";
import { gradientFor, initialFor } from "@/lib/employees/avatar";
import type {
  EmployeeMode,
  EmployeeStatus,
  EmployeeSummary,
} from "@/lib/employees/types";
import { employeeStore } from "@/stores/employees.store";

const STATUS_REFRESH_INTERVAL_MS = 30_000;

export const OPEN_EMPLOYEE_DETAIL_EVENT = "seren:open-employee-detail";

export type EmployeeDetailEventDetail = { employeeId: string };

const SectionLabel: Component<{ children: string }> = (props) => (
  <div class="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 select-none">
    {props.children}
  </div>
);

const Avatar: Component<{ name: string; seed: string; size?: number }> = (
  props,
) => {
  const size = () => props.size ?? 22;
  return (
    <div
      class="flex items-center justify-center text-white font-bold flex-none rounded-md"
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        background: gradientFor(props.seed),
        "font-size": `${Math.max(10, Math.floor(size() * 0.45))}px`,
      }}
      aria-hidden="true"
    >
      {initialFor(props.name)}
    </div>
  );
};

function statusDotClass(status: EmployeeStatus, mode: EmployeeMode): string {
  if (status === "running") {
    return mode === "cron" ? "bg-amber-400" : "bg-emerald-400";
  }
  if (status === "failed") return "bg-red-500";
  if (status === "stopped") return "bg-slate-500";
  if (status === "pending" || status === "building")
    return "bg-sky-400 animate-pulse";
  return "bg-slate-500";
}

function statusLabel(status: EmployeeStatus, mode: EmployeeMode): string {
  if (status === "running") return mode === "cron" ? "Scheduled" : "Live";
  if (status === "failed") return "Error";
  if (status === "stopped") return "Suspended";
  if (status === "pending") return "Pending";
  if (status === "building") return "Deploying";
  return status;
}

function modeLabel(mode: EmployeeMode): string {
  if (mode === "always_on") return "On-call";
  if (mode === "cron") return "Scheduled";
  return "On-demand";
}

const EmployeeRow: Component<{
  employee: EmployeeSummary;
  active: boolean;
  onSelect: (id: string) => void;
}> = (props) => (
  <button
    type="button"
    class="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md bg-transparent border-none text-left cursor-pointer transition-colors duration-100 hover:bg-surface-2"
    classList={{
      "bg-surface-2/70": props.active,
    }}
    onClick={() => props.onSelect(props.employee.id)}
    title={`${props.employee.name} (${modeLabel(props.employee.mode)})`}
    aria-label={`Open ${props.employee.name}, ${modeLabel(props.employee.mode)}, ${statusLabel(props.employee.status, props.employee.mode)}`}
  >
    <Avatar name={props.employee.name} seed={props.employee.avatarSeed} />
    <div class="flex-1 min-w-0">
      <div class="text-[12.5px] text-foreground truncate">
        {props.employee.name}
      </div>
      <div class="text-[10.5px] text-muted-foreground truncate">
        {modeLabel(props.employee.mode)}
        {" - "}
        {statusLabel(props.employee.status, props.employee.mode)}
      </div>
    </div>
    <span
      class={`w-1.5 h-1.5 rounded-full flex-none ${statusDotClass(props.employee.status, props.employee.mode)}`}
      aria-hidden="true"
    />
  </button>
);

export const EmployeesSection: Component = () => {
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [showCreate, setShowCreate] = createSignal(false);

  const employees = createMemo(() => employeeStore.employees);

  const handleSelect = (id: string) => {
    setActiveId(id);
    window.dispatchEvent(
      new CustomEvent<EmployeeDetailEventDetail>(OPEN_EMPLOYEE_DETAIL_EVENT, {
        detail: { employeeId: id },
      }),
    );
  };

  const handleNew = () => setShowCreate(true);

  const handleCreated = (id: string) => {
    setActiveId(id);
    window.dispatchEvent(
      new CustomEvent<EmployeeDetailEventDetail>(OPEN_EMPLOYEE_DETAIL_EVENT, {
        detail: { employeeId: id },
      }),
    );
  };

  let interval: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    )
      return;
    void employeeStore.refresh();
  };

  const handleVisibility = () => {
    if (document.visibilityState === "visible") {
      void employeeStore.refresh();
    }
  };

  onMount(() => {
    void employeeStore.refresh();
    interval = setInterval(tick, STATUS_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibility);
  });

  onCleanup(() => {
    if (interval !== null) clearInterval(interval);
    document.removeEventListener("visibilitychange", handleVisibility);
  });

  return (
    <div class="mb-1.5">
      <SectionLabel>Employees</SectionLabel>
      <div class="flex flex-col gap-0.5 px-1">
        <Show when={employeeStore.error}>
          <div
            class="px-2 py-1 text-[11px] text-status-error opacity-80"
            role="alert"
          >
            {employeeStore.error}
          </div>
        </Show>
        <For each={employees()}>
          {(employee) => (
            <EmployeeRow
              employee={employee}
              active={activeId() === employee.id}
              onSelect={handleSelect}
            />
          )}
        </For>
        <Show when={!employeeStore.loading && employees().length === 0}>
          <div class="px-2 py-1.5 text-[11px] text-muted-foreground/70">
            No employees yet
          </div>
        </Show>
        <button
          type="button"
          class="flex items-center gap-1.5 w-full px-2 py-1.5 mt-0.5 bg-transparent border border-dashed border-border/70 rounded-md text-muted-foreground text-[11.5px] cursor-pointer transition-colors duration-100 hover:border-primary/60 hover:text-primary hover:bg-primary/[0.06] focus-visible:outline-none focus-visible:border-primary/60 focus-visible:text-primary"
          onClick={handleNew}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 3v10M3 8h10"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
          New employee
        </button>
      </div>
      <Show when={showCreate()}>
        <CreateEmployeeModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      </Show>
    </div>
  );
};
