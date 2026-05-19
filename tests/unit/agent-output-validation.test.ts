// ABOUTME: Contract tests for #1987 Verified Agent Output finalization.
// ABOUTME: Ensures final assistant claims are backed by execution-ledger evidence.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractEvidenceFromAgentMessages,
  extractEvidenceFromToolLoopMessages,
  extractEvidenceFromUnifiedMessages,
  INITIAL_FINALIZATION_RULES,
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
      "I could not verify that the file was changed. I could not verify that the email was sent.",
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
      "I prepared the email draft, but I could not verify that it was sent.",
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
      "I could not verify that the service is unavailable.",
    );

    const unavailableWithFailedCheck = validateFinalOutput({
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
            result: "Publisher github-api not found",
          },
        }),
      ]),
    });
    expect(unavailableWithFailedCheck.claims[0]).toMatchObject({
      kind: "publisher_unavailable",
      status: "verified",
      evidenceToolCallIds: ["verify-1"],
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
      "I could not verify that the browser action completed.",
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
