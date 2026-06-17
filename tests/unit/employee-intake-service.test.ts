// ABOUTME: Regression coverage for the desktop-to-website employee intake handoff.
// ABOUTME: Verifies the payload shape expected by the website submission API.

import { describe, expect, it } from "vitest";
import {
  buildGeneralEmployeeIntakePayload,
  EMPLOYEE_INTAKE_CALENDLY_URL,
} from "@/services/employee-intake";

describe("employee intake service", () => {
  it("builds the general interview submission payload expected by the website", () => {
    expect(
      buildGeneralEmployeeIntakePayload({
        selectedEmployeeSlug: "cfo",
        goals: "  weekly cash visibility  ",
        requirements: " board-ready controls ",
        tools: " NetSuite, Excel ",
        discussionNotes: " implementation timeline ",
      }),
    ).toEqual({
      selected_employee_slug: "cfo",
      goals: "weekly cash visibility",
      requirements: "board-ready controls",
      tools: "NetSuite, Excel",
      discussion_notes: "implementation timeline",
      calendly_url: EMPLOYEE_INTAKE_CALENDLY_URL,
    });
  });
});
