// ABOUTME: Verifies connector settings uses desktop integration boundaries.
// ABOUTME: Guards authenticated clients, external links, and provider guidance.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const component = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/components/settings/ConnectorSettings.tsx",
  ),
  "utf8",
);

describe("connector settings integrations", () => {
  it("uses the authenticated publisher client wrappers", () => {
    expect(component).toContain('from "@/api/seren-agent"');
    expect(component).toContain('from "@/api/seren-cloud"');
    expect(component).not.toContain("api/generated/seren-agent");
    expect(component).not.toContain("api/generated/seren-cloud");
  });

  it("opens provider setup with the desktop external-link boundary", () => {
    expect(component).toContain('from "@/lib/external-link"');
    expect(component).toContain("void openExternalLink(setupUrl)");
    expect(component).not.toContain('target="_blank"');
  });

  it("distinguishes Slack bot and Socket Mode token setup", () => {
    expect(component).toContain("Click Create an App");
    expect(component).toContain("Do not click Generate Token");
    expect(component).toContain("Bot User OAuth Token");
    expect(component).toContain("chat:write");
    expect(component).toContain("app_mentions:read");
    expect(component).toContain("Enable Socket Mode");
    expect(component).toContain("connections:write");
    expect(component).toContain("xoxb-");
    expect(component).toContain("xapp-");
  });
});
