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
});
