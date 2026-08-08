// ABOUTME: Seren Models routing preference — maps user-facing Fastest/Cheapest
// ABOUTME: choices to the provider.sort wire values seren-router accepts.

import type { ProviderSort } from "./types";

/**
 * User-facing routing preference stored per thread (and as the settings-store
 * default for new threads). "fastest" keeps the server default by omitting
 * `provider.sort`; "cheapest" requests strict lowest-price routing.
 *
 * Balanced is deliberately absent: seren-router has not pinned a wire value
 * for it yet (#3749).
 */
export type RoutingPreference = "fastest" | "cheapest";

export const DEFAULT_ROUTING_PREFERENCE: RoutingPreference = "fastest";

export interface RoutingPreferenceOption {
  id: RoutingPreference;
  name: string;
  description: string;
}

/** Single source of truth for the selector and the settings default control. */
export const ROUTING_PREFERENCE_OPTIONS: RoutingPreferenceOption[] = [
  {
    id: "fastest",
    name: "Fastest",
    description: "Seren default — throughput-biased, price-capped routing",
  },
  {
    id: "cheapest",
    name: "Cheapest",
    description: "Lowest price — routes to the cheapest healthy provider",
  },
];

/**
 * Normalize a stored value to a known preference. Unknown or missing values
 * (legacy threads, downgraded builds) resolve to null = server default.
 */
export function normalizeRoutingPreference(
  value: string | null | undefined,
): RoutingPreference | null {
  return value === "fastest" || value === "cheapest" ? value : null;
}

/**
 * Resolve a preference to the `provider.sort` wire value. Fastest (and any
 * unset/unknown value) returns undefined so the field is omitted and the
 * server keeps its default Fastest policy.
 */
export function providerSortForPreference(
  value: string | null | undefined,
): ProviderSort | undefined {
  return normalizeRoutingPreference(value) === "cheapest" ? "price" : undefined;
}
