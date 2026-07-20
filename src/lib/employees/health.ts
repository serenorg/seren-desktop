// ABOUTME: Maps employee runtime state to a mode-independent health semantic.
// ABOUTME: Keeps sidebar, detail, and presence indicators consistent.

import type { EmployeeStatus } from "@/lib/employees/types";

export type EmployeeHealth =
  | "healthy"
  | "degraded"
  | "faulted"
  | "suspended"
  | "transitioning";

export function employeeHealth(input: {
  status: EmployeeStatus;
  errorMessage?: string | null;
  hasAlertConditions?: boolean;
}): EmployeeHealth {
  if (input.status === "failed") return "faulted";
  if (input.status === "stopped") return "suspended";
  if (input.status === "pending" || input.status === "building")
    return "transitioning";
  if (
    input.status === "running" &&
    (Boolean(input.errorMessage) || input.hasAlertConditions)
  ) {
    return "degraded";
  }
  return input.status === "running" ? "healthy" : "transitioning";
}

export function healthDotClass(health: EmployeeHealth): string {
  if (health === "healthy")
    return "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.55)]";
  if (health === "degraded")
    return "bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.55)]";
  if (health === "faulted")
    return "bg-red-500 shadow-[0_0_3px_rgba(248,113,113,0.5)]";
  if (health === "suspended") return "bg-slate-500";
  return "bg-sky-400 animate-pulse";
}

export function healthLabel(health: EmployeeHealth): string {
  if (health === "healthy") return "Live";
  if (health === "degraded") return "Degraded";
  if (health === "faulted") return "Error";
  if (health === "suspended") return "Suspended";
  return "Starting";
}
