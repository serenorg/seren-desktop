// ABOUTME: Guard for #3301 — the CLI-update-block and needs-attention OS banners
// ABOUTME: must route through the native notification plugin, not the WebView Notification API.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#3301 — CLI-update notifications use the native path", () => {
  // The Web `Notification` API is denied-by-default in this app's macOS
  // WebView (wry 0.55.1 implements no notification WKUIDelegate), so
  // `new Notification()` never paints a banner. If a future change
  // reintroduces it for these CLI-update surfaces, the banners silently
  // stop displaying on macOS again — exactly the #3301 regression.
  it("never posts CLI-update banners through the WebView Notification API", () => {
    expect(agentStoreSource).not.toMatch(/new Notification\(/);
    expect(agentStoreSource).not.toMatch(/Notification\.permission/);
    expect(agentStoreSource).not.toMatch(/Notification\.requestPermission/);
  });

  it("routes the #1646 CLI-update block banner through postNotification", () => {
    expect(agentStoreSource).toMatch(
      /postNotification\(\s*"Seren blocked a CLI update"/,
    );
  });

  it("routes the needs-attention banner through postNotification", () => {
    expect(agentStoreSource).toMatch(
      /postNotification\(\s*`\$\{action\.label\} needs attention`/,
    );
  });

  it("imports postNotification from the native notifications service", () => {
    expect(agentStoreSource).toMatch(
      /import\s*\{\s*postNotification\s*\}\s*from\s*"@\/services\/notifications"/,
    );
  });
});
