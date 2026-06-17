// ABOUTME: Regression guards for Seren Bounties sidebar and detail wiring.
// ABOUTME: Keeps cross-surface active-state events and skill scope selection intact.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appShellTsx = readFileSync(
  resolve("src/components/layout/AppShell.tsx"),
  "utf-8",
);
const bountyDetailTsx = readFileSync(
  resolve("src/components/bounties/BountyDetail.tsx"),
  "utf-8",
);
const bountiesSectionTsx = readFileSync(
  resolve("src/components/sidebar/BountiesSection.tsx"),
  "utf-8",
);
const threadSidebarTsx = readFileSync(
  resolve("src/components/layout/ThreadSidebar.tsx"),
  "utf-8",
);

function functionBody(name: string, source: string): string {
  const match = source.match(
    new RegExp(`const ${name} = \\([^)]*\\) => \\{([\\s\\S]*?)\\n  \\};`),
  );
  expect(match, `${name} should be present`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("Seren Bounties wiring", () => {
  it("clears employee sidebar selection when opening a bounty", () => {
    const body = functionBody("handleOpenBountyDetail", appShellTsx);

    expect(body).toContain("setActiveEmployeeId(null)");
    expect(body).toContain("CLOSE_EMPLOYEE_DETAIL_EVENT");
  });

  it("clears bounty sidebar selection when opening another main surface", () => {
    for (const handler of [
      "handleOpenEmployeeDetail",
      "handleOpenCatalog",
      "handleOpenInbox",
    ]) {
      const body = functionBody(handler, appShellTsx);
      expect(body).toContain("setActiveBountyId(null)");
      expect(body).toContain("setActiveBountyInheritFrom(null)");
      expect(body).toContain("CLOSE_BOUNTY_DETAIL_EVENT");
    }
  });

  it("only reuses the Seren-scoped bounty skill installation", () => {
    expect(bountyDetailTsx).toMatch(
      /s\.scope === "seren" &&\s+s\.slug === SEREN_BOUNTY_SLUG/,
    );
  });

  it("does not auto-dispatch OPEN_BOUNTY_DETAIL_EVENT on load", () => {
    // The sidebar must not auto-open the newest active bounty on startup.
    // Strong startup default is the Seren Employee intake landing; explicit
    // user selection is the only path to opening a bounty.
    expect(bountiesSectionTsx).not.toContain("autoOpenedDefault");
    expect(bountiesSectionTsx).not.toContain("setAutoOpenedDefault");
    // Guard: the only place dispatching OPEN_BOUNTY_DETAIL_EVENT must be
    // `handleSelectBounty`, which is only reachable via user click.
    expect(bountiesSectionTsx).not.toMatch(/createEffect\([^)]*handleSelectBounty/);
  });

  it("renders EmployeesSection before BountiesSection in the sidebar", () => {
    const employeesIdx = threadSidebarTsx.indexOf("<EmployeesSection");
    const bountiesIdx = threadSidebarTsx.indexOf("<BountiesSection");
    expect(employeesIdx).toBeGreaterThanOrEqual(0);
    expect(bountiesIdx).toBeGreaterThanOrEqual(0);
    expect(employeesIdx).toBeLessThan(bountiesIdx);
  });
});
