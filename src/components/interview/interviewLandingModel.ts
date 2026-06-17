// ABOUTME: Pure helpers for the Seren Employee intake landing.
// ABOUTME: Kept outside TSX so selection behavior can be tested without DOM rendering.

import type { EmployeeCatalogItem } from "@/api/employee-catalog";

const CATALOG_ASSET_ORIGIN = "https://serendb.com";

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
