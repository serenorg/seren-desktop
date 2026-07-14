// ABOUTME: Verifies settings uses one scroll owner for each panel column.
// ABOUTME: Prevents nested slide-panel scrolling from clipping long forms.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const settings = readFileSync(
  resolve(repoRoot, "src/components/settings/SettingsPanel.tsx"),
  "utf8",
);
const slidePanel = readFileSync(
  resolve(repoRoot, "src/components/layout/SlidePanel.tsx"),
  "utf8",
);

describe("settings scroll ownership", () => {
  it("keeps the wide slide panel fixed while settings columns scroll", () => {
    expect(slidePanel).toContain('"overflow-y-hidden": props.wide');
    expect(slidePanel).toContain('"overflow-y-auto": !props.wide');
    expect(settings).toContain(
      'class="flex h-full min-h-0 overflow-hidden bg-surface text-foreground"',
    );
    expect(settings).toContain(
      'class="min-h-0 flex-1 flex flex-col overflow-y-auto',
    );
    expect(settings).toContain(
      'class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain',
    );
  });
});
