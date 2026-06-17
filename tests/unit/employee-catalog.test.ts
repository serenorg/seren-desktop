// ABOUTME: Tests public Seren Employee catalog response normalization.
// ABOUTME: Guards the desktop intake catalog from deployed employee state coupling.

import { describe, expect, it } from "vitest";
import { normalizeEmployeeCatalogResponse } from "@/api/employee-catalog";

describe("employee catalog API normalization", () => {
  it("maps website catalog fields to desktop catalog items", () => {
    const catalog = normalizeEmployeeCatalogResponse({
      total: 1,
      clusters: [{ key: "finance-investment", label: "Finance & Investment" }],
      employees: [
        {
          slug: "cfo",
          title: "Chief Financial Officer",
          cluster: "finance-investment",
          seniority: 1,
          tagline: "A CFO for your CFO.",
          featured: true,
          image_url: "/employees/cfo.webp",
          hero_image_url: "/employees/cfo-hero.webp",
          skill_slug: "cfo",
          status: "running",
          mode: "always_on",
        },
      ],
    });

    expect(catalog.total).toBe(1);
    expect(catalog.employees[0]).toEqual({
      slug: "cfo",
      title: "Chief Financial Officer",
      cluster: "finance-investment",
      seniority: 1,
      tagline: "A CFO for your CFO.",
      featured: true,
      imageUrl: "/employees/cfo.webp",
      heroImageUrl: "/employees/cfo-hero.webp",
      skillSlug: "cfo",
    });
    expect(catalog.employees[0]).not.toHaveProperty("status");
    expect(catalog.employees[0]).not.toHaveProperty("mode");
  });

  it("fails loudly when employees are missing", () => {
    expect(() =>
      normalizeEmployeeCatalogResponse({
        clusters: [],
      }),
    ).toThrow("employees[]");
  });
});
