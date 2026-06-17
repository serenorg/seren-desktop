// ABOUTME: Tests general Seren Employee intake telemetry payloads.
// ABOUTME: Guards against reintroducing per-employee interview-intent state.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEmployeeInterestTelemetryPayload,
  websiteApiUrl,
} from "@/services/telemetry";

describe("employee interview telemetry", () => {
  it("builds a general interview-launched payload with optional role context", () => {
    expect(
      buildEmployeeInterestTelemetryPayload(
        {
          employeeSlug: "ciso",
          source: "desktop-deep-link",
        },
        new Date("2026-06-17T01:00:00.000Z"),
      ),
    ).toEqual({
      selected_employee_slug: "ciso",
      event: "interview-launched",
      source: "desktop-deep-link",
      occurred_at: "2026-06-17T01:00:00.000Z",
    });
  });

  it("keeps no-context launches general", () => {
    expect(
      buildEmployeeInterestTelemetryPayload({
        employeeSlug: null,
        event: "role-selected",
        source: "desktop-role-selection",
      }).selected_employee_slug,
    ).toBeNull();
  });

  it("targets the website telemetry API", () => {
    expect(websiteApiUrl("/api/telemetry/employee-interest")).toBe(
      "https://serendb.com/api/telemetry/employee-interest",
    );
  });

  it("does not add interview-intent fetch wiring", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const shell = readFileSync(resolve("src/components/layout/AppShell.tsx"), "utf8");

    expect(app).not.toContain("interview-intent");
    expect(shell).not.toContain("interview-intent");
    expect(app).toContain("OPEN_INTERVIEW_LANDING_EVENT");
    expect(shell).toContain("recordEmployeeInterest");
  });
});
