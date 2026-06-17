// ABOUTME: Guards the general Seren Employee intake landing selection rules.
// ABOUTME: Keeps the desktop landing catalog-driven instead of deployed-employee-driven.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogAssetUrl,
  resolveInterviewEmployeeSlug,
} from "@/components/interview/interviewLandingModel";

const catalog = Array.from({ length: 15 }, (_, index) => ({
  slug: index === 0 ? "cfo" : `role-${index}`,
}));

describe("InterviewLanding", () => {
  it("preselects a known employee slug from deep-link context", () => {
    expect(resolveInterviewEmployeeSlug(catalog, "cfo")).toBe("cfo");
  });

  it("falls back to the general intake when no valid context is present", () => {
    expect(resolveInterviewEmployeeSlug(catalog, null)).toBeNull();
    expect(resolveInterviewEmployeeSlug(catalog, "missing-role")).toBeNull();
  });

  it("keeps all 15 catalog roles available to the no-context landing", () => {
    expect(catalog).toHaveLength(15);
    expect(resolveInterviewEmployeeSlug(catalog, undefined)).toBeNull();
  });

  it("normalizes website asset paths for desktop rendering", () => {
    expect(catalogAssetUrl("/employees/cfo.webp")).toBe(
      "https://serendb.com/employees/cfo.webp",
    );
    expect(catalogAssetUrl("https://cdn.example/role.webp")).toBe(
      "https://cdn.example/role.webp",
    );
  });
});

describe("AppShell interview landing wiring", () => {
  const appShell = readFileSync(
    resolve("src/components/layout/AppShell.tsx"),
    "utf8",
  );

  it("opens the interview landing on first launch instead of the skills panel", () => {
    expect(appShell).toContain("loadInitialInterviewLanding()");
    expect(appShell).toContain('if (raw === null) return null');
    expect(appShell).toContain("INTERVIEW_LANDING_DISMISSED_KEY");
  });

  it("listens for desktop interview deep links", () => {
    expect(appShell).toContain("listenForInterviewLaunch");
    expect(appShell).toContain("OPEN_INTERVIEW_LANDING_EVENT");
  });
});
