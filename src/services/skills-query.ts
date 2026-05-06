// ABOUTME: TanStack Query options for the Seren Skills catalog.
// ABOUTME: Loads the browse catalog page-by-page for infinite scrolling.

import { infiniteQueryOptions } from "@tanstack/solid-query";
import { type SkillsCatalogPage, skills } from "@/services/skills";

export const SKILLS_CATALOG_PAGE_SIZE = 40;
export const skillsCatalogQueryKey = ["skills", "catalog"] as const;

export function skillsCatalogOptions(query: string) {
  const trimmedQuery = query.trim();
  return infiniteQueryOptions<
    SkillsCatalogPage,
    Error,
    { pages: SkillsCatalogPage[]; pageParams: number[] },
    readonly ["skills", "catalog", string],
    number
  >({
    queryKey: [...skillsCatalogQueryKey, trimmedQuery],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      skills.fetchCatalogPage(
        SKILLS_CATALOG_PAGE_SIZE,
        pageParam,
        trimmedQuery,
      ),
    getNextPageParam: (lastPage) => lastPage.nextOffset,
  });
}
