// ABOUTME: Sidebar section listing virtual employees (deployed seren-agent workers).
// ABOUTME: Shows status dots, pending approval counts, and click-to-open detail.

import {
  type Component,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { gradientFor, initialFor } from "@/lib/employees/avatar";
import type {
  ArchivedEmployee,
  EmployeeMode,
  EmployeeStatus,
  EmployeeSummary,
} from "@/lib/employees/types";
import {
  employeeApprovals,
  type OrgPendingApprovalRun,
} from "@/services/employee-approvals";
import { employeeStore } from "@/stores/employees.store";
import { type Thread, threadStore } from "@/stores/thread.store";

const STATUS_REFRESH_INTERVAL_MS = 30_000;

export const OPEN_EMPLOYEE_DETAIL_EVENT = "seren:open-employee-detail";
export const CLOSE_EMPLOYEE_DETAIL_EVENT = "seren:close-employee-detail";

export type EmployeeDetailEventDetail = { employeeId: string };

interface EmployeesSectionProps {
  onCreateEmployee: () => void;
}

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

function relativeArchivedTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

const ArchivedEmployeeRow: Component<{
  employee: ArchivedEmployee;
  active: boolean;
  onSelect: (id: string) => void;
}> = (props) => (
  <button
    type="button"
    class="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md bg-transparent border-none text-left cursor-pointer transition-colors duration-100 hover:bg-surface-2 opacity-60 hover:opacity-80"
    classList={{
      "bg-surface-2/70 opacity-90": props.active,
    }}
    onClick={() => props.onSelect(props.employee.id)}
    title={`${props.employee.name} (archived ${relativeArchivedTime(props.employee.archivedAt)})`}
    aria-label={`Open archived employee ${props.employee.name}, deleted ${relativeArchivedTime(props.employee.archivedAt)}`}
  >
    <div
      class="flex items-center justify-center text-white font-bold flex-none rounded-md grayscale"
      style={{
        width: "22px",
        height: "22px",
        background: gradientFor(props.employee.avatarSeed),
        "font-size": "10px",
      }}
      aria-hidden="true"
    >
      {initialFor(props.employee.name)}
    </div>
    <div class="flex-1 min-w-0">
      <div class="text-[12.5px] text-muted-foreground truncate line-through decoration-muted-foreground/40">
        {props.employee.name}
      </div>
      <div class="text-[10.5px] text-muted-foreground/70 truncate">
        Archived · {relativeArchivedTime(props.employee.archivedAt)}
      </div>
    </div>
  </button>
);

const EmployeeRow: Component<{
  employee: EmployeeSummary;
  active: boolean;
  pendingCount: number;
  onSelect: (id: string) => void;
}> = (props) => {
  const pluralRuns = () => (props.pendingCount === 1 ? "" : "s");
  const ariaSuffix = () =>
    props.pendingCount > 0
      ? `, ${props.pendingCount} run${pluralRuns()} need approval`
      : "";
  return (
    <button
      type="button"
      class="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-md bg-transparent border-none text-left cursor-pointer transition-colors duration-100 hover:bg-surface-2"
      classList={{
        "bg-surface-2/70": props.active,
      }}
      onClick={() => props.onSelect(props.employee.id)}
      title={`${props.employee.name} (${modeLabel(props.employee.mode)})`}
      aria-label={`Open ${props.employee.name}, ${modeLabel(props.employee.mode)}, ${statusLabel(props.employee.status, props.employee.mode)}${ariaSuffix()}`}
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
      <Show when={props.pendingCount > 0}>
        <span
          class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-200 text-[10px] font-semibold leading-none"
          title={`${props.pendingCount} run${pluralRuns()} awaiting approval`}
          aria-hidden="true"
        >
          {props.pendingCount}
        </span>
      </Show>
      <span
        class={`w-1.5 h-1.5 rounded-full flex-none ${statusDotClass(props.employee.status, props.employee.mode)}`}
        aria-hidden="true"
      />
    </button>
  );
};

export const EmployeesSection: Component<EmployeesSectionProps> = (props) => {
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [pendingByDeployment, setPendingByDeployment] = createSignal<
    Map<string, OrgPendingApprovalRun[]>
  >(new Map());

  const employees = createMemo(() => employeeStore.employees);
  const archivedEmployees = createMemo(() =>
    employeeStore.archived.filter(
      (archived) => employeeStore.byId(archived.id) === undefined,
    ),
  );
  const threadsByEmployee = createMemo(() => threadStore.threadsByEmployee);

  const refreshPending = async () => {
    try {
      const rows = await employeeApprovals.listOrg(100);
      setPendingByDeployment(employeeApprovals.groupByDeployment(rows));
    } catch {
      // Sidebar approval badge is best-effort; a transient inbox failure
      // should not poison the sidebar. The next tick retries.
    }
  };

  const pendingCountFor = (deploymentId: string): number =>
    pendingByDeployment().get(deploymentId)?.length ?? 0;

  const handleSelect = (id: string) => {
    setActiveId(id);
    window.dispatchEvent(
      new CustomEvent<EmployeeDetailEventDetail>(OPEN_EMPLOYEE_DETAIL_EVENT, {
        detail: { employeeId: id },
      }),
    );
  };

  const handleOpenEmployeeDetail = (event: Event) => {
    const detail = (event as CustomEvent<EmployeeDetailEventDetail>).detail;
    setActiveId(detail?.employeeId ?? null);
  };

  const handleCloseEmployeeDetail = () => {
    setActiveId(null);
  };

  let interval: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    )
      return;
    void employeeStore.refresh();
    void refreshPending();
  };

  const handleVisibility = () => {
    if (document.visibilityState === "visible") {
      void employeeStore.refresh();
      void refreshPending();
    }
  };

  onMount(() => {
    void employeeStore.refresh();
    void refreshPending();
    interval = setInterval(tick, STATUS_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener(
      OPEN_EMPLOYEE_DETAIL_EVENT,
      handleOpenEmployeeDetail,
    );
    window.addEventListener(
      CLOSE_EMPLOYEE_DETAIL_EVENT,
      handleCloseEmployeeDetail,
    );
  });

  onCleanup(() => {
    if (interval !== null) clearInterval(interval);
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener(
      OPEN_EMPLOYEE_DETAIL_EVENT,
      handleOpenEmployeeDetail,
    );
    window.removeEventListener(
      CLOSE_EMPLOYEE_DETAIL_EVENT,
      handleCloseEmployeeDetail,
    );
  });

  return (
    <div class="mb-1.5">
      <div class="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70 select-none">
        Employees
      </div>
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
          {(employee) => {
            const threads = (): Thread[] =>
              threadsByEmployee()[employee.id] ?? [];
            return (
              <div>
                <EmployeeRow
                  employee={employee}
                  active={activeId() === employee.id}
                  pendingCount={pendingCountFor(employee.id)}
                  onSelect={handleSelect}
                />
                <For each={threads()}>
                  {(thread) => (
                    <button
                      type="button"
                      class="flex items-center w-full pl-9 pr-2 py-1 rounded-md bg-transparent border-none text-left cursor-pointer transition-colors duration-100 hover:bg-surface-2"
                      classList={{
                        "bg-surface-2/70":
                          threadStore.activeThreadId === thread.id,
                      }}
                      onClick={() => {
                        threadStore.selectThread(thread.id, thread.kind);
                        // Clear the active employee highlight and tell
                        // AppShell to close the detail pane so the chat
                        // takes over the main content area.
                        setActiveId(null);
                        window.dispatchEvent(
                          new CustomEvent(CLOSE_EMPLOYEE_DETAIL_EVENT),
                        );
                      }}
                      title={thread.title}
                    >
                      <span class="text-[11.5px] text-muted-foreground truncate">
                        {thread.title}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            );
          }}
        </For>
        <Show when={archivedEmployees().length > 0}>
          <Show when={employees().length > 0}>
            <div
              class="mx-2 my-1 border-t border-border/40"
              aria-hidden="true"
            />
          </Show>
          <For each={archivedEmployees()}>
            {(archived) => {
              const archivedThreads = (): Thread[] =>
                threadsByEmployee()[archived.id] ?? [];
              return (
                <div>
                  <ArchivedEmployeeRow
                    employee={archived}
                    active={activeId() === archived.id}
                    onSelect={handleSelect}
                  />
                  <For each={archivedThreads()}>
                    {(thread) => (
                      <button
                        type="button"
                        class="flex items-center w-full pl-9 pr-2 py-1 rounded-md bg-transparent border-none text-left cursor-pointer transition-colors duration-100 hover:bg-surface-2 opacity-70"
                        classList={{
                          "bg-surface-2/70":
                            threadStore.activeThreadId === thread.id,
                        }}
                        onClick={() => {
                          threadStore.selectThread(thread.id, thread.kind);
                          setActiveId(null);
                          window.dispatchEvent(
                            new CustomEvent(CLOSE_EMPLOYEE_DETAIL_EVENT),
                          );
                        }}
                        title={thread.title}
                      >
                        <span class="text-[11.5px] text-muted-foreground/80 truncate">
                          {thread.title}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              );
            }}
          </For>
        </Show>
        <button
          type="button"
          class="group flex items-center gap-2.5 w-full px-2 py-1.5 mt-0.5 rounded-md bg-transparent border-none text-left cursor-pointer transition-colors duration-100 hover:bg-surface-2 focus-visible:outline-none focus-visible:bg-surface-2 focus-visible:ring-1 focus-visible:ring-primary/40"
          onClick={props.onCreateEmployee}
          aria-label="New employee"
        >
          <span
            class="flex items-center justify-center w-[22px] h-[22px] rounded-md border border-dashed border-border/80 text-muted-foreground/80 transition-colors duration-100 group-hover:border-primary/50 group-hover:text-primary"
            aria-hidden="true"
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
          </span>
          <div class="flex-1 min-w-0">
            <div class="text-[12.5px] text-muted-foreground truncate transition-colors duration-100 group-hover:text-foreground">
              New employee
            </div>
            <div class="text-[10.5px] text-muted-foreground/70 truncate">
              Persistent cloud worker
            </div>
          </div>
        </button>
      </div>
    </div>
  );
};
