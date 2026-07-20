import {
  employeeHealth,
  healthDotClass,
} from "@/lib/employees/health";
import { describe, expect, it } from "vitest";

describe("employee health", () => {
  it("treats a running employee as healthy and green", () => {
    expect(employeeHealth({ status: "running" })).toBe("healthy");
    expect(healthDotClass("healthy")).toContain("bg-emerald-400");
  });

  it("treats a running cron employee identically to any running employee", () => {
    expect(employeeHealth({ status: "running" })).toBe("healthy");
    expect(healthDotClass(employeeHealth({ status: "running" }))).toContain(
      "bg-emerald-400",
    );
  });

  it("marks runtime warnings as degraded and amber", () => {
    expect(
      employeeHealth({ status: "running", errorMessage: "runtime warning" }),
    ).toBe("degraded");
    expect(healthDotClass("degraded")).toContain("bg-amber-400");
  });

  it.each([
    ["failed", "faulted"],
    ["stopped", "suspended"],
    ["pending", "transitioning"],
    ["building", "transitioning"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(employeeHealth({ status })).toBe(expected);
  });
});
