// ABOUTME: Protects the persistent Mission Control entry in the left sidebar.
// ABOUTME: Confirms its placement and renderer-only open-panel callback path.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const employeeSectionSource = readFileSync(
  resolve("src/components/sidebar/EmployeesSection.tsx"),
  "utf8",
);
const threadSidebarSource = readFileSync(
  resolve("src/components/layout/ThreadSidebar.tsx"),
  "utf8",
);
const appShellSource = readFileSync(
  resolve("src/components/layout/AppShell.tsx"),
  "utf8",
);

describe("Mission Control sidebar entry", () => {
  it("places New Mission below New employee and opens Mission Control", () => {
    const newEmployee = employeeSectionSource.indexOf(
      'aria-label="New employee"',
    );
    const newMission = employeeSectionSource.indexOf(
      'data-testid="sidebar-new-mission"',
    );
    const approvalInbox = employeeSectionSource.indexOf(
      'data-testid="sidebar-approval-inbox"',
    );

    expect(newEmployee).toBeGreaterThanOrEqual(0);
    expect(newMission).toBeGreaterThan(newEmployee);
    expect(approvalInbox).toBeGreaterThan(newMission);
    expect(employeeSectionSource).toContain(
      "onClick={props.onCreateMission}",
    );
    expect(employeeSectionSource).toContain('aria-label="New Mission"');
    expect(threadSidebarSource).toContain(
      "onCreateMission={props.onCreateMission}",
    );

    const openHandlerStart = appShellSource.indexOf(
      "const handleOpenMissionControl",
    );
    const toggleSkillsStart = appShellSource.indexOf(
      "const handleToggleSkills",
      openHandlerStart,
    );
    expect(openHandlerStart).toBeGreaterThanOrEqual(0);
    expect(appShellSource.slice(openHandlerStart, toggleSkillsStart)).toContain(
      'setSlidePanel("missioncontrol")',
    );
    expect(appShellSource).toContain(
      "onCreateMission={handleOpenMissionControl}",
    );
  });
});
