// ABOUTME: Regression coverage for malformed Agent Catalog rows.
// ABOUTME: Keeps catalog data drift from crashing the desktop shell.

import { describe, expect, it } from "vitest";
import {
  normalizeAgentCatalogEntries,
  normalizeAgentCatalogEntry,
} from "@/services/agent-catalog";

describe("agent catalog normalization", () => {
  it("normalizes nullable display fields without throwing", () => {
    const entry = normalizeAgentCatalogEntry({
      id: "entry-1",
      kind: "agent",
      name: "triage-agent",
      namespace: null,
      version: "1.0.0",
      description: null,
      deprecated: null,
      labels: null,
      source: undefined,
      updated_at: null,
    });

    expect(entry).toMatchObject({
      id: "entry-1",
      kind: "agent",
      name: "triage-agent",
      namespace: "default",
      version: "1.0.0",
      description: "",
      deprecated: false,
      labels: {},
      source: { type: "inline" },
      updated_at: "",
    });
  });

  it("drops rows that cannot render or support actions safely", () => {
    const entries = normalizeAgentCatalogEntries([
      {
        id: "valid",
        kind: "prompt",
        name: "brief",
        namespace: "default",
        version: "2026.06.17",
        updated_at: "2026-06-17T18:04:13.000Z",
      },
      {
        id: "missing-kind",
        name: "bad-row",
        namespace: "default",
        version: "1.0.0",
      },
      {
        id: "unknown-kind",
        kind: "future_kind",
        name: "future-row",
        namespace: "default",
        version: "1.0.0",
      },
      {
        kind: "agent",
        name: "missing-id",
        namespace: "default",
        version: "1.0.0",
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("valid");
  });
});
