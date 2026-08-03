// ABOUTME: Pure helpers for the Seren Employee intake landing.
// ABOUTME: Kept outside TSX so selection behavior can be tested without DOM rendering.

import type { EmployeeCatalogItem } from "@/api/employee-catalog";

const CATALOG_ASSET_ORIGIN = "https://serendb.com";

export const INTAKE_PERSISTENCE_RETRY_MESSAGE =
  "We couldn't save your intake. Your answers are still here. Please try Send and Schedule again.";

export const INTAKE_SCHEDULING_RETRY_MESSAGE =
  "Your intake was saved, but Calendly didn't open. Use Open Calendly below.";

export type PersistedIntakeHandoffResult =
  | "scheduling-opened"
  | "scheduling-open-failed";

export async function runPersistedIntakeHandoff(
  persist: () => Promise<void>,
  onPersisted: () => void,
  openScheduling: () => Promise<void>,
): Promise<PersistedIntakeHandoffResult> {
  await persist();
  onPersisted();

  try {
    await openScheduling();
    return "scheduling-opened";
  } catch {
    return "scheduling-open-failed";
  }
}

export function catalogAssetUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${CATALOG_ASSET_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

export function resolveInterviewEmployeeSlug(
  employees: readonly Pick<EmployeeCatalogItem, "slug">[],
  requestedSlug?: string | null,
): string | null {
  if (!requestedSlug) return null;
  return employees.some((employee) => employee.slug === requestedSlug)
    ? requestedSlug
    : null;
}

// Keep a still-valid manual selection when the catalog list is replaced (e.g.
// a Refresh or a background reload), otherwise fall back to the deep-link slug.
export function nextInterviewSelection(
  currentSlug: string | null,
  employees: readonly Pick<EmployeeCatalogItem, "slug">[],
  requestedSlug?: string | null,
): string | null {
  if (
    currentSlug &&
    employees.some((employee) => employee.slug === currentSlug)
  ) {
    return currentSlug;
  }
  return resolveInterviewEmployeeSlug(employees, requestedSlug);
}

export function clusterLabel(
  employee: Pick<EmployeeCatalogItem, "cluster">,
): string {
  return employee.cluster
    .split("-")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
