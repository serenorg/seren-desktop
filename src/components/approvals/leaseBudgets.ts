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
export function leaseBudgetsFromInputs(
  maxCalls: number,
  maxSpendInput: string,
): LeaseBudgets {
  const calls = Math.max(1, Math.floor(maxCalls));
  const spend = Number.parseFloat(maxSpendInput);
  const maxSpendMicros =
    Number.isFinite(spend) && spend > 0
      ? Math.round(spend * MICROS_PER_UNIT)
      : null;
  return { maxCalls: calls, maxSpendMicros, asset: null };
}
