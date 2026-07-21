// ABOUTME: Static UI contract for Happy app discovery in Remote Access settings.
// ABOUTME: Keeps the explanation, official destinations, ratings, and safe link path visible.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const remoteSettings = readFileSync(
  resolve("src/components/settings/HappyRemoteSettings.tsx"),
  "utf-8",
);

describe("Happy Remote Access app discovery (#3127)", () => {
  it("explains Happy and exposes the verified install and learn-more actions", () => {
    expect(remoteSettings).toContain(
      "Happy is the free, open-source mobile remote control",
    );
    expect(remoteSettings).toContain("https://happy.engineering/");
    expect(remoteSettings).toContain(
      "https://apps.apple.com/us/app/happy-claude-code-client/id6748571505",
    );
    expect(remoteSettings).toContain(
      "https://play.google.com/store/apps/details?id=com.ex3ndr.happy",
    );
    expect(remoteSettings).toContain('score: "4.9"');
    expect(remoteSettings).toContain('count: "970+ ratings"');
    expect(remoteSettings).toContain('score: "4.8"');
    expect(remoteSettings).toContain('count: "2.9k+ reviews"');
    expect(remoteSettings).toContain('import { openExternalLink }');
    expect(remoteSettings).toContain("void openExternalLink(HAPPY_WEBSITE_URL)");
    expect(remoteSettings).toContain("void openExternalLink(store.url)");
  });
});
