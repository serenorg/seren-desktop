// ABOUTME: Regression coverage for #3675: the key injected into skill child
// ABOUTME: processes must never carry publisher-administration scopes.

import { describe, expect, it } from "vitest";
import {
  DESKTOP_API_KEY_SCOPES,
  SKILL_API_KEY_SCOPES,
} from "@/services/desktop-api-access";

const ADMINISTRATION_PREFIXES = [
  "publisher-definition:",
  "publisher-pricing:",
  "oauth-provider:",
  "oauth-connection:",
  "organization:",
  "managed-deployment:",
];

describe("skill API key scopes (#3675)", () => {
  it("grants publisher invocation and nothing else", () => {
    expect([...SKILL_API_KEY_SCOPES]).toEqual(["publisher:*"]);
  });

  it("carries no administration scope that the approval gate protects", () => {
    // These are safe on the Desktop key because every mutation through it is
    // classified HighRisk on the MCP dispatch path. That gate cannot apply to
    // a value a skill process already holds, so it must not be exported.
    for (const scope of SKILL_API_KEY_SCOPES) {
      for (const prefix of ADMINISTRATION_PREFIXES) {
        expect(scope.startsWith(prefix)).toBe(false);
      }
    }
  });

  it("is a strict subset of the Desktop key", () => {
    const desktop = new Set<string>(DESKTOP_API_KEY_SCOPES);
    for (const scope of SKILL_API_KEY_SCOPES) {
      expect(desktop.has(scope)).toBe(true);
    }
    expect(SKILL_API_KEY_SCOPES.length).toBeLessThan(
      DESKTOP_API_KEY_SCOPES.length,
    );
  });
});
