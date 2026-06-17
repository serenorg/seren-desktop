// ABOUTME: Guards the general Seren Employee intake landing selection rules.
// ABOUTME: Keeps the desktop landing catalog-driven instead of deployed-employee-driven.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogAssetUrl,
  nextInterviewSelection,
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

  it("preserves a still-valid manual selection across a catalog refresh", () => {
    expect(nextInterviewSelection("role-3", catalog, "cfo")).toBe("role-3");
    expect(nextInterviewSelection("role-3", catalog, null)).toBe("role-3");
  });

  it("re-seeds from the deep-link slug when the selection is gone or absent", () => {
    expect(nextInterviewSelection(null, catalog, "cfo")).toBe("cfo");
    expect(nextInterviewSelection("removed-role", catalog, "cfo")).toBe("cfo");
    expect(nextInterviewSelection("removed-role", catalog, null)).toBeNull();
  });
});

describe("AppShell interview landing wiring", () => {
  const appShell = readFileSync(
    resolve("src/components/layout/AppShell.tsx"),
    "utf8",
  );

  it("uses a strong startup default for the interview landing", () => {
    expect(appShell).toContain("loadInitialInterviewLanding()");
    // Strong default: the loader returns `true` unconditionally and does not
    // consult the legacy persistent-dismissal key. Closing is session-only.
    expect(appShell).toMatch(
      /function loadInitialInterviewLanding\(\): boolean \{[\s\S]*?return true;[\s\S]*?\}/,
    );
    expect(appShell).not.toContain("INTERVIEW_LANDING_DISMISSED_KEY");
    expect(appShell).not.toContain("persistInterviewLandingDismissed");
  });

  it("submits the desktop intake instead of dispatching an unhandled queued event", () => {
    const landing = readFileSync(
      resolve("src/components/interview/InterviewLanding.tsx"),
      "utf8",
    );

    expect(landing).toContain("submitGeneralEmployeeIntake");
    expect(landing).toContain("EMPLOYEE_INTAKE_CALENDLY_URL");
    expect(landing).not.toContain("Intake queued for Seren Employee customization");
    expect(appShell).not.toContain("seren:start-employee-interview");
  });

  it("listens for desktop interview deep links", () => {
    expect(appShell).toContain("listenForInterviewLaunch");
    expect(appShell).toContain("OPEN_INTERVIEW_LANDING_EVENT");
  });
});
