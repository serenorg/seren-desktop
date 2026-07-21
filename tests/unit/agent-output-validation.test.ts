// ABOUTME: Contract tests for #1987 Verified Agent Output finalization.
// ABOUTME: Ensures final assistant claims are backed by execution-ledger evidence.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractEvidenceFromAgentMessages,
  extractEvidenceFromToolLoopMessages,
  extractEvidenceFromUnifiedMessages,
  INITIAL_FINALIZATION_RULES,
  SUBSTITUTION_MARKER,
  validateFinalOutput,
} from "@/lib/agent-output-validation";
import type { UnifiedMessage } from "@/types/conversation";

const requiredRuleIds = [
  "file_write_claim_requires_diff_or_successful_file_tool",
  "file_edit_claim_requires_diff_or_successful_file_tool",
  "email_sent_claim_requires_successful_send_tool",
  "draft_created_claim_requires_successful_draft_tool",
  "db_persisted_claim_requires_successful_db_tool",
  "publisher_unavailable_claim_requires_failed_live_verification",
  "tool_completed_claim_rejects_pending_approval",
  "tool_completed_claim_rejects_is_error_result",
  "browser_action_claim_requires_successful_browser_tool",
  "no_memory_storage_for_unverified_completion_claims",
] as const;

function unifiedTool(
  overrides: Partial<UnifiedMessage> & {
    toolCall: NonNullable<UnifiedMessage["toolCall"]>;
  },
): UnifiedMessage {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: "tool_call",
    role: "assistant",
    content: overrides.content ?? overrides.toolCall.title,
    timestamp: Date.now(),
    status: "complete",
    toolCallId: overrides.toolCall.toolCallId,
    ...overrides,
  };
}

describe("#1987 Verified Agent Output", () => {
  it("ships the complete deterministic rule registry", () => {
    expect(INITIAL_FINALIZATION_RULES.map((rule) => rule.id)).toEqual(
      requiredRuleIds,
    );
  });

  it("verifies a file-write claim with matching diff evidence", () => {
    const evidence = extractEvidenceFromUnifiedMessages([
      {
        id: "diff-1",
        type: "diff",
        role: "assistant",
        content: "File changed: README.md",
        timestamp: Date.now(),
        status: "complete",
        toolCallId: "tool-1",
        diff: {
          path: "README.md",
          oldText: "",
          newText: "# Verified",
          toolCallId: "tool-1",
        },
      },
    ]);

    const report = validateFinalOutput({
      finalText: "I created README.md.",
      evidence,
    });

    expect(report.safeDisplayText).toBe("I created README.md.");
    expect(report.canStoreMemory).toBe(true);
    expect(report.claims).toMatchObject([
      {
        kind: "file_write",
        status: "verified",
        evidenceToolCallIds: ["tool-1"],
      },
    ]);
  });

  it("rewrites failed and pending completion claims before memory storage", () => {
    const evidence = extractEvidenceFromUnifiedMessages([
      unifiedTool({
        toolCallId: "tool-failed",
        toolCall: {
          toolCallId: "tool-failed",
          title: "write_file",
          kind: "file",
          name: "write_file",
          status: "error",
          isError: true,
          result: "Error: permission denied",
        },
      }),
      unifiedTool({
        toolCallId: "tool-pending",
        toolCall: {
          toolCallId: "tool-pending",
          title: "send_email",
          kind: "gmail",
          name: "gateway__gmail__post_messages_send",
          status: "pending",
        },
      }),
    ]);

    const report = validateFinalOutput({
      finalText: "I wrote the file and sent the email.",
      evidence,
    });

    expect(report.safeDisplayText).toBe(
      `${SUBSTITUTION_MARKER} I could not verify that the file was changed. I could not verify that the email was sent.`,
    );
    expect(report.canStoreMemory).toBe(false);
    expect(report.claims.map((claim) => claim.status)).toEqual([
      "unverified",
      "unverified",
    ]);
  });

  it("distinguishes email drafts from sent email", () => {
    const evidence = extractEvidenceFromUnifiedMessages([
      unifiedTool({
        toolCallId: "draft-1",
        toolCall: {
          toolCallId: "draft-1",
          title: "Create Gmail draft",
          kind: "gmail",
          name: "gateway__gmail__post_drafts",
          status: "completed",
          result: '{"id":"draft-123"}',
        },
      }),
    ]);

    const report = validateFinalOutput({
      finalText: "I created the email draft and sent the email.",
      evidence,
    });

    expect(report.claims).toMatchObject([
      { kind: "email_sent", status: "unverified" },
      { kind: "draft_created", status: "verified" },
    ]);
    expect(report.safeDisplayText).toBe(
      `${SUBSTITUTION_MARKER} I prepared the email draft, but I could not verify that it was sent.`,
    );
  });

  it("verifies DB persistence and requires live verification before unavailable claims", () => {
    const dbEvidence = extractEvidenceFromUnifiedMessages([
      unifiedTool({
        toolCallId: "db-1",
        toolCall: {
          toolCallId: "db-1",
          title: "run_sql_transaction",
          kind: "serendb",
          name: "mcp__seren_mcp__run_sql_transaction",
          status: "completed",
          result: "COMMIT",
        },
      }),
    ]);

    const dbReport = validateFinalOutput({
      finalText: "I saved the record to the database.",
      evidence: dbEvidence,
    });
    expect(dbReport.claims[0]).toMatchObject({
      kind: "db_persisted",
      status: "verified",
      evidenceToolCallIds: ["db-1"],
    });

    const unavailableWithoutCheck = validateFinalOutput({
      finalText: "GitHub is unavailable in this session.",
      evidence: extractEvidenceFromUnifiedMessages([]),
    });
    expect(unavailableWithoutCheck.safeDisplayText).toBe(
      `${SUBSTITUTION_MARKER} I could not verify that the service is unavailable.`,
    );

    const unavailableWithMalformedCheck = validateFinalOutput({
      finalText: "GitHub is unavailable in this session.",
      evidence: extractEvidenceFromUnifiedMessages([
        unifiedTool({
          toolCallId: "verify-1",
          toolCall: {
            toolCallId: "verify-1",
            title: "list_agent_publishers",
            kind: "seren-mcp",
            name: "mcp__seren_mcp__list_agent_publishers",
            status: "error",
            isError: true,
            result: "Invalid arguments: unknown field slug",
          },
        }),
      ]),
    });
    expect(unavailableWithMalformedCheck.claims[0]).toMatchObject({
      kind: "publisher_unavailable",
      status: "unverified",
      evidenceToolCallIds: [],
    });

    // The real list_agent_publishers tool returns the catalog as JSON, never
    // prose like "not found" — a successful live list that omits GitHub is the
    // evidence, and the absence is the agent's client-side filter (#2918).
    const unavailableWithFreshAbsence = validateFinalOutput({
      finalText: "GitHub is unavailable in this session.",
      evidence: extractEvidenceFromUnifiedMessages([
        unifiedTool({
          toolCallId: "verify-2",
          toolCall: {
            toolCallId: "verify-2",
            title: "list_agent_publishers",
            kind: "seren-mcp",
            name: "mcp__seren_mcp__list_agent_publishers",
            status: "completed",
            result:
              '{"publishers":[{"slug":"seren-notes"},{"slug":"seren-whisper"}]}',
          },
        }),
      ]),
    });
    expect(unavailableWithFreshAbsence.claims[0]).toMatchObject({
      kind: "publisher_unavailable",
      status: "verified",
      evidenceToolCallIds: ["verify-2"],
    });
  });

  it("credits Claude auto-memory intercepts as out-of-band database write evidence", () => {
    const report = validateFinalOutput({
      finalText: "I saved the memory record to the database.",
      evidence: {
        diffs: [],
        tools: [
          {
            id: "claude-memory-1",
            name: "claude_memory_interceptor",
            title: "Claude Memory Interceptor",
            kind: "database",
            status: "completed",
            result:
              "Persisted Claude memory to claude_agent_preferences; memory_md=/Users/a/.claude/projects/-Users-a-proj/memory/MEMORY.md",
            isError: false,
          },
        ],
      },
    });

    expect(report.safeDisplayText).toBe(
      "I saved the memory record to the database.",
    );
    expect(report.canStoreMemory).toBe(true);
    expect(report.claims[0]).toMatchObject({
      kind: "db_persisted",
      status: "verified",
      evidenceToolCallIds: ["claude-memory-1"],
    });
  });

  it("validates browser claims against browser-tool evidence", () => {
    const successReport = validateFinalOutput({
      finalText: "I took a screenshot of the website.",
      evidence: extractEvidenceFromUnifiedMessages([
        unifiedTool({
          toolCallId: "browser-1",
          toolCall: {
            toolCallId: "browser-1",
            title: "playwright_screenshot",
            kind: "browser",
            name: "playwright_screenshot",
            status: "completed",
            result: "/tmp/screenshot.png",
          },
        }),
      ]),
    });
    expect(successReport.claims[0]).toMatchObject({
      kind: "browser_action",
      status: "verified",
    });

    const failedReport = validateFinalOutput({
      finalText: "I clicked the button on the website.",
      evidence: extractEvidenceFromUnifiedMessages([
        unifiedTool({
          toolCallId: "browser-2",
          toolCall: {
            toolCallId: "browser-2",
            title: "playwright_click",
            kind: "browser",
            name: "playwright_click",
            status: "error",
            isError: true,
            result: "Element not found",
          },
        }),
      ]),
    });
    expect(failedReport.safeDisplayText).toBe(
      `${SUBSTITUTION_MARKER} I could not verify that the browser action completed.`,
    );
  });

  it("normalizes evidence from local-agent and direct chat finalization paths", () => {
    const agentReport = validateFinalOutput({
      finalText: "I updated the file.",
      evidence: extractEvidenceFromAgentMessages([
        {
          id: "agent-diff",
          type: "diff",
          content: "Modified: src/app.ts",
          timestamp: Date.now(),
          toolCallId: "agent-tool",
          diff: {
            sessionId: "session-1",
            toolCallId: "agent-tool",
            path: "src/app.ts",
            oldText: "old",
            newText: "new",
          },
        },
      ]),
    });
    expect(agentReport.claims[0]).toMatchObject({
      kind: "file_edit",
      status: "verified",
    });

    const chatReport = validateFinalOutput({
      finalText: "I sent the email.",
      evidence: extractEvidenceFromToolLoopMessages([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "chat-send",
              type: "function",
              function: {
                name: "gateway__gmail__post_messages_send",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "chat-send",
          content: '{"id":"msg-123"}',
        },
      ]),
    });
    expect(chatReport.claims[0]).toMatchObject({
      kind: "email_sent",
      status: "verified",
      evidenceToolCallIds: ["chat-send"],
    });
  });

  it("preserves markdown structure and unrelated content when rewriting (#3105)", () => {
    const finalText = [
      "## Parity verdicts",
      "",
      "| Feature | Status |",
      "| --- | --- |",
      "| Unified Context | Exists in `provider-bindings.ts` |",
      "",
      "1. Host reliability",
      "2. Remote host",
      "",
      "```ts",
      "// updated the file",
      "```",
      "",
      "The Gemini publisher is not available in this session.",
      "",
      "That is the end of the audit.",
    ].join("\n");

    const report = validateFinalOutput({
      finalText,
      evidence: extractEvidenceFromUnifiedMessages([]),
    });

    // Only the offending sentence is replaced; every other byte is identical.
    expect(report.safeDisplayText).toBe(
      finalText.replace(
        "The Gemini publisher is not available in this session.",
        `${SUBSTITUTION_MARKER} I could not verify that the service is unavailable.`,
      ),
    );
    // The block structure that markdown rendering depends on survives.
    expect(report.safeDisplayText).toContain("## Parity verdicts\n");
    expect(report.safeDisplayText).toContain("| --- | --- |\n");
    // Fenced code is never claim-matched, so a prose rule cannot overwrite it
    // even though this line matches the file_edit pattern.
    expect(report.safeDisplayText).toContain("```ts\n// updated the file\n```");
    // Tokens are never split mid-word by the sentence walker.
    expect(report.safeDisplayText).toContain("`provider-bindings.ts`");
    expect(report.claims).toMatchObject([
      { kind: "publisher_unavailable", status: "unverified" },
    ]);
  });

  it("only treats capability claims as publisher_unavailable (#3108)", () => {
    const fires = (finalText: string) =>
      validateFinalOutput({
        finalText,
        evidence: extractEvidenceFromUnifiedMessages([]),
      }).claims.some((claim) => claim.kind === "publisher_unavailable");

    // Prose that merely contains an availability word is not a claim about
    // this agent's capabilities and must reach the user untouched.
    for (const sentence of [
      "The conference room was not available on Tuesday.",
      "Seats in economy are unavailable for that flight.",
      "This endpoint returns 503 when the upstream is unavailable.",
      "Their build tool is not available for Windows.",
    ]) {
      expect(fires(sentence), sentence).toBe(false);
    }

    // Real capability claims stay guarded. The first is the phrasing from the
    // #2910 incident this rule was written for, which never matched before.
    for (const sentence of [
      "google-sheets is not exposed in the current publisher list.",
      "GitHub is unavailable in this session.",
      "The Slack integration is not configured.",
      "I don't have a tool for that.",
    ]) {
      expect(fires(sentence), sentence).toBe(true);
    }

    // Unrelated prose is passed through byte-for-byte, with no substitution
    // marker anywhere in the message.
    const passage =
      "The conference room was not available on Tuesday.\n\nWe moved the review to Thursday.";
    const report = validateFinalOutput({
      finalText: passage,
      evidence: extractEvidenceFromUnifiedMessages([]),
    });
    expect(report.safeDisplayText).toBe(passage);
    expect(report.safeDisplayText).not.toContain(SUBSTITUTION_MARKER);
    expect(report.canStoreMemory).toBe(true);
  });

  it("marks substituted sentences without disturbing markdown (#3109)", () => {
    const finalText = [
      "## Findings",
      "",
      "| Item | State |",
      "| --- | --- |",
      "| Sync | Exists |",
      "",
      "The connector is not available here.",
      "",
      "Everything else checked out.",
    ].join("\n");

    const report = validateFinalOutput({
      finalText,
      evidence: extractEvidenceFromUnifiedMessages([]),
    });

    // The substitution is disclosed rather than passed off as agent prose.
    expect(report.safeDisplayText).toContain(SUBSTITUTION_MARKER);
    // The marker is inline-level, so it cannot open a block and break the
    // surrounding structure the way the #3105 rewrite did.
    expect(SUBSTITUTION_MARKER).not.toContain("\n");
    expect(report.safeDisplayText).toBe(
      finalText.replace(
        "The connector is not available here.",
        `${SUBSTITUTION_MARKER} I could not verify that the service is unavailable.`,
      ),
    );
    // The unsupported claim itself is not restored alongside the disclosure.
    expect(report.safeDisplayText).not.toContain("The connector is not");
  });

  it("wires validation into all required finalization paths", () => {
    const chatSource = readFileSync("src/services/chat.ts", "utf8");
    const orchestratorSource = readFileSync(
      "src/services/orchestrator.ts",
      "utf8",
    );
    const agentSource = readFileSync("src/stores/agent.store.ts", "utf8");

    expect(chatSource).toContain("extractEvidenceFromToolLoopMessages");
    expect(chatSource).toContain("finalOutputValidation");
    expect(orchestratorSource).toContain("extractEvidenceFromUnifiedMessages");
    expect(orchestratorSource).toContain("finalOutputValidation");
    expect(agentSource).toContain("extractEvidenceFromAgentMessages");
    expect(agentSource).toContain("finalOutputValidation");
  });
});
