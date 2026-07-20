// ABOUTME: Converts employee spend values to exact integer micro-dollar totals.
// ABOUTME: Provides rolling-window and display helpers for employee cost UI.

import type { EmployeeRun } from "@/lib/employees/types";

export const SPEND_POLL_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000,
];

export function nextSpendPollDelayMs(
  attempt: number,
  baselineRunCount: number | null,
  observedRunCount: number,
): number | null {
  if (
    baselineRunCount === null ||
    observedRunCount > baselineRunCount ||
    attempt >= SPEND_POLL_DELAYS_MS.length
  ) {
    return null;
  }
  return SPEND_POLL_DELAYS_MS[attempt];
}

export function parseUsdToMicros(value: string): number {
  const [wholePart, fractionPart = ""] = value.split(".");
  const wholeMicros = Number.parseInt(wholePart, 10) * 1_000_000;
  const fractionMicros = Number.parseInt(
    fractionPart.slice(0, 6).padEnd(6, "0") || "0",
    10,
  );
  return wholeMicros + fractionMicros;
}

export function formatMicrosUsd(micros: number): string {
  if (micros === 0) return "$0.00";
  const precision = micros < 10_000 ? 4 : 2;
  return `$${(micros / 1e6).toFixed(precision)}`;
}

export function sumRunCostMicros(runs: EmployeeRun[]): number {
  return runs.reduce(
    (total, run) => total + run.inferenceCostAtomic + run.computeCostAtomic,
    0,
  );
}

export function windowStartIso(now: number, days: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}
