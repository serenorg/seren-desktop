// ABOUTME: Source-level guards for Meeting Mode usability regressions from #2228.
// ABOUTME: Keeps capture controls reachable and transcript review out of the narrow sidebar layout.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Meeting Mode top-right entry point (#2228)", () => {
  it("opens Meetings from a titlebar icon instead of the lower-left text row", () => {
    const titlebar = source("src/components/layout/Titlebar.tsx");
    const appShell = source("src/components/layout/AppShell.tsx");
    const sidebar = source("src/components/layout/ThreadSidebar.tsx");

    expect(titlebar).toContain("onToggleMeetings");
    expect(titlebar).toContain('data-testid="titlebar-meetings-button"');
    expect(titlebar.indexOf('title="Meetings"')).toBeLessThan(
      titlebar.indexOf('title="Settings"'),
    );
    expect(appShell).toContain("handleToggleMeetings");
    expect(appShell).toContain("onToggleMeetings={handleToggleMeetings}");
    expect(sidebar).not.toContain('data-testid="meetings-button"');
  });
});

describe("Meeting Mode transcript layout (#2228)", () => {
  it("uses a reader-width slide panel and removes the narrow detail max-width", () => {
    const appShell = source("src/components/layout/AppShell.tsx");
    const slidePanel = source("src/components/layout/SlidePanel.tsx");
    const detail = source("src/components/meeting/MeetingDetail.tsx");

    expect(appShell).toContain('reader={slidePanel() === "meetings"}');
    expect(slidePanel).toContain("reader?: boolean");
    expect(slidePanel).toContain('props.reader ? "1040px"');
    expect(detail).toContain("max-w-none");
    expect(detail).not.toContain("max-w-[760px]");
  });
});

describe("Meeting capture widget behavior (#2228)", () => {
  it("positions the widget near the top-right and keeps its timer reactive", () => {
    const widgetService = source("src/services/captureWidget.ts");
    const widget = source("src/components/meeting/CaptureWidget.tsx");

    expect(widgetService).toContain("captureWidgetPosition");
    expect(widgetService).toContain("currentMonitor");
    expect(widgetService).toContain("WIDGET_MARGIN");
    expect(widgetService).toContain("x:");
    expect(widgetService).toContain("y:");
    expect(widget).toContain("const [tick, setTick]");
    expect(widget).toContain("tick();");
    expect(widget).toContain('data-tauri-drag-region');
  });
});
