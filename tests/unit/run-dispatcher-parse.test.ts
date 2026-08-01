// ABOUTME: Verifies the strict agent findings output contract.
// ABOUTME: Covers fenced JSON extraction, defaults, inferred approvals, and parse failures.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/run", () => ({
  runAddCoverageGap: vi.fn(),
  runCompleteTask: vi.fn(),
  runFinishAttempt: vi.fn(),
  runRecordFinding: vi.fn(),
  runStartAttempt: vi.fn(),
  runVerifyTask: vi.fn(),
}));
vi.mock("@/stores/agent.store", () => ({ agentStore: {} }));
vi.mock("@/stores/fileTree", () => ({ fileTreeState: { rootPath: null } }));
vi.mock("@/stores/run.store", () => ({
  runState: { snapshot: null, activeRunId: null },
}));

import { parseAgentFindings } from "@/services/run-dispatcher";

describe("parseAgentFindings", () => {
  it("parses the last seren-findings block and applies confidence and approval defaults", () => {
    const text = [
      "The first draft was superseded.",
      "```seren-findings",
      '{"findings":[],"coverage_gaps":[]}',
      "```",
      "Final answer:",
      "```seren-findings",
      JSON.stringify({
        findings: [
          {
            claim: "The report is ready.",
            evidence: [
              {
                kind: "file_range",
                locator: "report.md:1-4",
                excerpt: "ready",
              },
            ],
            proposed_artifact: { kind: "email", uri: "draft:report" },
          },
        ],
      }),
      "```",
    ].join("\n");

    const parsed = parseAgentFindings(text);
    expect(parsed?.findings).toEqual([
      {
        claim: "The report is ready.",
        confidence: "asserted",
        evidence: [
          {
            kind: "file_range",
            locator: "report.md:1-4",
            excerpt: "ready",
          },
        ],
        proposed_artifact: { kind: "email", uri: "draft:report" },
        needs_approval: true,
      },
    ]);
    expect(parsed?.coverage_gaps).toEqual([]);
  });

  it("parses a trailing bare JSON object after prose", () => {
    const parsed = parseAgentFindings(
      'I checked the source. {"findings":[{"claim":"A fact","confidence":"verified","evidence":[]}],"coverage_gaps":[]}',
    );
    expect(parsed?.findings[0].confidence).toBe("verified");
    expect(parsed?.findings[0].needs_approval).toBe(false);
  });

  it("returns null for malformed JSON", () => {
    expect(parseAgentFindings("```seren-findings\n{bad json}\n```"))
      .toBeNull();
  });

  it("returns null when the findings block is missing or has invalid evidence", () => {
    expect(parseAgentFindings("No structured result was produced.")).toBeNull();
    expect(
      parseAgentFindings(
        '```seren-findings\n{"findings":[{"claim":"bad","evidence":[{"kind":"unknown","locator":"x","excerpt":"y"}]}]}\n```',
      ),
    ).toBeNull();
  });
});
