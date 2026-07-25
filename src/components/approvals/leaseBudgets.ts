// ABOUTME: Pure money-bounding conversion for the "Approve for this task" lease
// ABOUTME: editor: editor inputs -> LeaseBudgets (call count + optional spend cap).

import type { LeaseBudgets } from "@/services/tool-authorization";

/** Micro-units per whole currency unit (USDC/SerenBucks are metered in micros). */
export const MICROS_PER_UNIT = 1_000_000;

/**
 * Build the lease budgets from the editor inputs. A blank or non-positive spend
 * cap leaves `maxSpendMicros` null (no monetary allowance — a priced call still
 * escalates), and the asset is left unpinned so any charged asset counts against
 * a set ceiling (a conservative fail-safe that escalates earlier, never
 * mischarges).
 */
/** Upper bound on a task lease's call budget. Also caps a non-finite input
 * (e.g. `Number("1e999") === Infinity`), which would otherwise serialize to
 * JSON null and become an unmetered (`max_calls: None`) lease in the gate. */
export const MAX_LEASE_CALLS = 100_000;

export function leaseBudgetsFromInputs(
  maxCalls: number,
  maxSpendInput: string,
): LeaseBudgets {
  const requested = Number.isFinite(maxCalls)
    ? Math.floor(maxCalls)
    : MAX_LEASE_CALLS;
  const calls = Math.min(MAX_LEASE_CALLS, Math.max(1, requested));
  const spend = Number.parseFloat(maxSpendInput);
  const maxSpendMicros =
    Number.isFinite(spend) && spend > 0
      ? Math.round(spend * MICROS_PER_UNIT)
      : null;
  return { maxCalls: calls, maxSpendMicros, asset: null };
}
