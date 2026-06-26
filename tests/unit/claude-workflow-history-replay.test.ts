// ABOUTME: Regression guard for #2666 - completed Claude workflow sidecar
// ABOUTME: results must replay into restored Seren agent thread history.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error - .mjs source is JS; type info isn't generated.
import {
  formatClaudeWorkflowResultForReplay,
  readClaudeWorkflowReplayMessages,
} from "../../bin/browser-local/claude-runtime.mjs";

describe("#2666 - Claude workflow sidecar history replay", () => {
  it("formats completed workflow result metadata as visible assistant text", () => {
    const text = formatClaudeWorkflowResultForReplay({
      workflowName: "deep-research",
      result: {
        summary: "No authoritative CCO-signable playbook exists.",
        findings: [
          {
            claim: "The field is fragmented.",
            confidence: "high",
            evidence: "SEC and FINRA materials do not publish a standard.",
            sources: ["https://example.com/sec", "https://example.com/finra"],
          },
        ],
        caveats: "Paywalled vendor docs were not inspected.",
        openQuestions: ["Whether COMPLY has an unpublished template."],
      },
    });

    expect(text).toContain("### deep-research result");
    expect(text).toContain("No authoritative CCO-signable playbook exists.");
    expect(text).toContain("1. The field is fragmented.");
    expect(text).toContain("Confidence: high");
    expect(text).toContain("Sources: https://example.com/sec");
    expect(text).toContain("#### Caveats");
    expect(text).toContain("#### Open questions");
  });

  it("reads completed sidecar workflows next to the Claude session jsonl", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-workflow-replay-"));
    const sessionId = "session-123";
    const projectDir = path.join(root, "project");
    const workflowDir = path.join(projectDir, sessionId, "workflows");
    await mkdir(workflowDir, { recursive: true });

    const historyPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(historyPath, "", "utf8");
    await writeFile(
      path.join(workflowDir, "wf_done.json"),
      JSON.stringify({
        runId: "wf_done",
        status: "completed",
        timestamp: "2026-06-26T08:15:23.853Z",
        workflowName: "deep-research",
        result: {
          summary: "Recovered sidecar result.",
          findings: [{ claim: "The missing output exists." }],
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(workflowDir, "wf_running.json"),
      JSON.stringify({
        runId: "wf_running",
        status: "running",
        result: { summary: "Do not replay in-progress output." },
      }),
      "utf8",
    );

    const messages = await readClaudeWorkflowReplayMessages(
      historyPath,
      sessionId,
      "",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: "claude-workflow-result:wf_done",
      text: expect.stringContaining("Recovered sidecar result."),
      timestamp: Date.parse("2026-06-26T08:15:23.853Z"),
    });
  });

  it("skips sidecar output already present in parent assistant history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-workflow-replay-"));
    const sessionId = "session-456";
    const projectDir = path.join(root, "project");
    const workflowDir = path.join(projectDir, sessionId, "workflows");
    await mkdir(workflowDir, { recursive: true });

    const historyPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(historyPath, "", "utf8");
    await writeFile(
      path.join(workflowDir, "wf_done.json"),
      JSON.stringify({
        runId: "wf_done",
        status: "completed",
        workflowName: "deep-research",
        result: {
          summary:
            "This exact completed workflow result was already written into the parent assistant transcript and should not replay twice.",
        },
      }),
      "utf8",
    );

    const messages = await readClaudeWorkflowReplayMessages(
      historyPath,
      sessionId,
      "This exact completed workflow result was already written into the parent assistant transcript and should not replay twice.",
    );

    expect(messages).toEqual([]);
  });
});
