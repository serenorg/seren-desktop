// ABOUTME: Deterministic Mission Control dispatcher for ready run tasks.
// ABOUTME: It turns agent replies into durable findings, coverage gaps, and attempt results.

import { createEffect, createRoot } from "solid-js";
import { reportError } from "@/lib/support/hook";
import {
  continueToolIteration,
  getActiveModel,
  streamMessageWithTools,
} from "@/services/chat";
import type { AgentType } from "@/services/providers";
import {
  type AgentAssignment,
  type Attempt,
  type CoverageGap,
  type Evidence,
  type EvidenceKind,
  type Finding,
  type FindingConfidence,
  type RunSnapshot,
  runAddCoverageGap,
  runCompleteTask,
  runFinishAttempt,
  runRecordFinding,
  runStartAttempt,
  runVerifyTask,
  type Task,
} from "@/services/run";
import { getLiveSerenModelCatalog } from "@/services/seren-model-catalog";
import { agentStore } from "@/stores/agent.store";
import { fileTreeState } from "@/stores/fileTree";
import { runState } from "@/stores/run.store";

const MAX_CONCURRENT_TASKS = 3;
const TURN_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 50;

const EVIDENCE_KINDS = new Set<EvidenceKind>([
  "command_result",
  "file_range",
  "email",
  "document",
  "url",
  "log_excerpt",
  "publisher_result",
]);
const CONFIDENCES = new Set<FindingConfidence>([
  "asserted",
  "verified",
  "refuted",
]);
const ARTIFACT_KINDS = new Set(["diff", "document", "email", "comment"]);
// The CLIs that can raise an action-required state, and the agent types each
// one blocks. claude-codex drives both, so either blocks it.
const AGENTS_BLOCKED_BY_CLI: Record<"claude" | "codex", AgentType[]> = {
  claude: ["claude-code", "claude-codex"],
  codex: ["codex", "claude-codex"],
};
const NATIVE_AGENT_TYPES = new Set<AgentType>([
  "claude-code",
  "codex",
  "gemini",
  "grok",
  "claude-codex",
  "lmstudio",
]);

export interface ParsedEvidence {
  kind: EvidenceKind;
  locator: string;
  excerpt: string;
}

export interface ParsedArtifact {
  kind: "diff" | "document" | "email" | "comment";
  uri?: string;
  digest?: string;
}

export interface ParsedFinding {
  claim: string;
  confidence: FindingConfidence;
  evidence: ParsedEvidence[];
  proposed_artifact?: ParsedArtifact;
  needs_approval: boolean;
}

export interface ParsedCoverageGap {
  kind: string;
  subject: string;
  detail?: string;
}

export interface ParsedAgentFindings {
  findings: ParsedFinding[];
  coverage_gaps: ParsedCoverageGap[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseCandidate(value: unknown): ParsedAgentFindings | null {
  if (!isRecord(value) || !Array.isArray(value.findings)) return null;

  const findings: ParsedFinding[] = [];
  for (const item of value.findings) {
    if (!isRecord(item) || !nonEmptyString(item.claim)) return null;
    const confidence = item.confidence ?? "asserted";
    if (
      typeof confidence !== "string" ||
      !CONFIDENCES.has(confidence as FindingConfidence)
    ) {
      return null;
    }
    if (!Array.isArray(item.evidence)) return null;
    const evidence: ParsedEvidence[] = [];
    for (const evidenceItem of item.evidence) {
      if (
        !isRecord(evidenceItem) ||
        !nonEmptyString(evidenceItem.kind) ||
        !EVIDENCE_KINDS.has(evidenceItem.kind as EvidenceKind) ||
        !nonEmptyString(evidenceItem.locator) ||
        typeof evidenceItem.excerpt !== "string"
      ) {
        return null;
      }
      evidence.push({
        kind: evidenceItem.kind as EvidenceKind,
        locator: evidenceItem.locator,
        excerpt: evidenceItem.excerpt,
      });
    }

    let proposed_artifact: ParsedArtifact | undefined;
    if (item.proposed_artifact !== undefined) {
      if (
        !isRecord(item.proposed_artifact) ||
        !nonEmptyString(item.proposed_artifact.kind)
      ) {
        return null;
      }
      if (!ARTIFACT_KINDS.has(item.proposed_artifact.kind)) return null;
      if (
        item.proposed_artifact.uri !== undefined &&
        !nonEmptyString(item.proposed_artifact.uri)
      ) {
        return null;
      }
      if (
        item.proposed_artifact.digest !== undefined &&
        !nonEmptyString(item.proposed_artifact.digest)
      ) {
        return null;
      }
      proposed_artifact = {
        kind: item.proposed_artifact.kind as ParsedArtifact["kind"],
        ...(item.proposed_artifact.uri
          ? { uri: item.proposed_artifact.uri }
          : {}),
        ...(item.proposed_artifact.digest
          ? { digest: item.proposed_artifact.digest }
          : {}),
      };
    }

    if (
      item.needs_approval !== undefined &&
      typeof item.needs_approval !== "boolean"
    ) {
      return null;
    }
    const inferredApproval =
      proposed_artifact?.kind === "email" ||
      proposed_artifact?.kind === "comment";
    findings.push({
      claim: item.claim,
      confidence: confidence as FindingConfidence,
      evidence,
      proposed_artifact,
      needs_approval: item.needs_approval ?? inferredApproval,
    });
  }

  const rawGaps = value.coverage_gaps ?? [];
  if (!Array.isArray(rawGaps)) return null;
  const coverage_gaps: ParsedCoverageGap[] = [];
  for (const item of rawGaps) {
    if (!isRecord(item) || !nonEmptyString(item.subject)) return null;
    if (item.kind !== undefined && !nonEmptyString(item.kind)) return null;
    if (item.detail !== undefined && typeof item.detail !== "string")
      return null;
    coverage_gaps.push({
      kind: (item.kind as string | undefined) ?? "other",
      subject: item.subject,
      ...(item.detail ? { detail: item.detail } : {}),
    });
  }
  return { findings, coverage_gaps };
}

function fencedCandidates(text: string): unknown[] {
  const matches = [
    ...text.matchAll(/```\s*seren-findings\s*\n?([\s\S]*?)```/gi),
  ];
  return matches.map((match) => {
    try {
      return JSON.parse(match[1].trim()) as unknown;
    } catch {
      return null;
    }
  });
}

function trailingJsonCandidate(text: string): unknown | null {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  for (
    let start = text.lastIndexOf("{", end);
    start >= 0;
    start = text.lastIndexOf("{", start - 1)
  ) {
    try {
      const candidate: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(candidate) && "findings" in candidate) return candidate;
    } catch {
      // Try the next enclosing object. Prose may contain braces of its own.
    }
  }
  return null;
}

export function parseAgentFindings(text: string): ParsedAgentFindings | null {
  const candidates = fencedCandidates(text);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const parsed = parseCandidate(candidates[index]);
    if (parsed) return parsed;
  }
  const trailing = trailingJsonCandidate(text);
  return trailing ? parseCandidate(trailing) : null;
}

export function buildTaskPrompt(
  objective: string,
  task: Pick<Task, "title" | "brief">,
): string {
  return [
    `Mission objective: ${objective}`,
    `Task: ${task.title}`,
    `Task brief: ${task.brief}`,
    "",
    "Investigate the task using the available tools and workspace.",
    "Report only claims you can support. State what you could not check as coverage_gaps.",
    "Include a coverage_gaps entry for every material boundary you did not exercise, such as leases or worktree provisioning.",
    "End your reply with a fenced JSON block tagged seren-findings using this shape:",
    "```seren-findings",
    '{"findings":[{"claim":"...","confidence":"asserted|verified|refuted","evidence":[{"kind":"command_result|file_range|email|document|url|log_excerpt|publisher_result","locator":"...","excerpt":"..."}],"proposed_artifact":{"kind":"diff|document|email|comment","uri":"...","digest":"..."},"needs_approval":false}],"coverage_gaps":[{"kind":"other","subject":"...","detail":"..."}]}',
    "```",
  ].join("\n");
}

export function selectReadyTasks(
  tasks: Task[],
  inFlight: ReadonlySet<string>,
  cap = MAX_CONCURRENT_TASKS,
): Task[] {
  // The cap bounds total concurrency, so tasks already running count against
  // it. The dispatch effect re-runs on every snapshot change; without this,
  // each re-run would admit a fresh capful on top of the in-flight ones.
  return tasks
    .filter((task) => task.state === "ready" && !inFlight.has(task.id))
    .slice(0, Math.max(0, cap - inFlight.size));
}

export interface DispatchPlan {
  task: Task;
  assignment: AgentAssignment;
}

export function selectDispatchPlan(
  tasks: Task[],
  assignments: AgentAssignment[],
  inFlight: ReadonlySet<string>,
  cap = MAX_CONCURRENT_TASKS,
  assignmentOffset = 0,
  attempts: readonly Attempt[] = [],
): DispatchPlan[] {
  if (assignments.length === 0) return [];
  const attemptedByTask = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    if (!attempt.agent_assignment_id) continue;
    const attempted =
      attemptedByTask.get(attempt.task_id) ?? new Set<string>();
    attempted.add(attempt.agent_assignment_id);
    attemptedByTask.set(attempt.task_id, attempted);
  }

  return selectReadyTasks(tasks, inFlight, cap).map((task, index) => {
    const attempted = attemptedByTask.get(task.id);
    // Round-robin picks the next agent in rotation, which for a retry can be
    // the one that just failed this task. Prefer any agent it has not been
    // through yet, so an unhealthy agent type cannot keep the task.
    const untried = attempted
      ? assignments.filter((candidate) => !attempted.has(candidate.id))
      : assignments;
    const pool = untried.length > 0 ? untried : assignments;
    return {
      task,
      assignment: pool[(assignmentOffset + index) % pool.length],
    };
  });
}

function toFinding(
  runId: string,
  taskId: string,
  attemptId: string,
  finding: ParsedFinding,
): Finding {
  const timestamp = Date.now();
  const evidence: Evidence[] = finding.evidence.map((item) => ({
    kind: item.kind,
    reference: item.locator,
    excerpt: item.excerpt || null,
  }));
  const artifact = finding.proposed_artifact;
  return {
    id: crypto.randomUUID(),
    run_id: runId,
    task_id: taskId,
    attempt_id: attemptId,
    claim: finding.claim,
    confidence: finding.confidence,
    evidence,
    proposed_artifact: artifact
      ? {
          kind: artifact.kind,
          title: artifact.uri ?? artifact.digest ?? finding.claim,
          content: artifact.uri ?? artifact.digest ?? null,
        }
      : null,
    needs_approval: finding.needs_approval,
    status: "open",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function toCoverageGap(
  runId: string,
  taskId: string,
  gap: ParsedCoverageGap,
): CoverageGap {
  return {
    id: crypto.randomUUID(),
    run_id: runId,
    task_id: taskId,
    kind: gap.kind,
    subject: gap.subject,
    detail: gap.detail ?? null,
    created_at: Date.now(),
  };
}

function isTerminalRun(snapshot: RunSnapshot | null): boolean {
  return (
    !!snapshot &&
    ["completed", "partial", "failed", "cancelled"].includes(
      snapshot.run.status,
    )
  );
}

async function waitForTurn(sessionId: string): Promise<void> {
  const deadline = Date.now() + TURN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = agentStore.sessions[sessionId];
    if (!session)
      throw new Error("agent session disappeared before completion");
    // A runtime whose CLI needs repair or installation will never produce a
    // turn, so waiting out the full timeout only delays the reroute.
    const blocked = agentStore.cliUpdateActionRequired;
    if (
      blocked &&
      AGENTS_BLOCKED_BY_CLI[blocked.bareCommand]?.includes(
        session.info.agentType,
      )
    ) {
      throw new Error(
        `${session.info.agentType} cannot run until its CLI is repaired (${blocked.reason})`,
      );
    }
    const threadId = session.conversationId;
    const active =
      agentStore.isTurnInFlight(threadId) ||
      session.info.status === "prompting";
    if (!active) {
      if (
        session.info.status === "error" ||
        session.info.status === "terminated"
      ) {
        throw new Error(
          session.error ?? `agent session ended with ${session.info.status}`,
        );
      }
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("agent turn exceeded the dispatcher wait limit");
}

function finalAssistantMessage(sessionId: string): string | null {
  const session = agentStore.sessions[sessionId];
  if (!session) return null;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.type === "assistant" && message.content.trim())
      return message.content;
  }
  return null;
}

async function recordGap(
  runId: string,
  taskId: string,
  kind: string,
  subject: string,
  detail: string,
): Promise<void> {
  await runAddCoverageGap(
    toCoverageGap(runId, taskId, { kind, subject, detail }),
  );
}

function isNativeAgentType(agentType: string): agentType is AgentType {
  return NATIVE_AGENT_TYPES.has(agentType as AgentType);
}

/**
 * Use the signed-in Seren model when a launch-box assignment is not backed by
 * a local CLI, or when a local CLI cannot start. The assignment remains the
 * durable source of truth; this fallback keeps a run honest by recording the
 * provider boundary as a coverage gap alongside the model's own findings.
 */
async function runSerenChatTask(
  objective: string,
  task: Task,
): Promise<string> {
  let continuation: Parameters<typeof continueToolIteration>[0] | null = null;
  const activeModel = getActiveModel();
  const model =
    activeModel !== "auto"
      ? activeModel
      : (await getLiveSerenModelCatalog())[0]?.id;
  if (!model) {
    throw new Error("Seren model catalog returned no usable model");
  }

  for await (const event of streamMessageWithTools(
    buildTaskPrompt(objective, task),
    model,
    undefined,
    true,
  )) {
    if (event.type === "complete") return event.finalContent;
    if (event.type === "iteration_limit") {
      continuation = event.continueState;
      break;
    }
  }

  if (continuation) {
    for await (const event of continueToolIteration(continuation, 10)) {
      if (event.type === "complete") return event.finalContent;
    }
  }

  throw new Error("Seren chat task did not produce a final response");
}

async function dispatchTask(
  snapshot: RunSnapshot,
  task: Task,
  assignment: AgentAssignment,
  ownedSessionIds: Map<string, string>,
): Promise<void> {
  const runId = snapshot.run.id;
  const localSessionId = crypto.randomUUID();
  let attemptId: string | null = null;
  let spawnedSessionId: string | null = null;
  try {
    attemptId = await runStartAttempt(
      runId,
      task.id,
      assignment.id,
      localSessionId,
    );
    let response: string | null = null;
    let fallbackDetail: string | null = null;

    if (!isNativeAgentType(assignment.agent_type)) {
      fallbackDetail = `assignment ${assignment.agent_type} uses the signed-in Seren chat model because no local runtime supports that label`;
      response = await runSerenChatTask(snapshot.run.objective, task);
    } else {
      try {
        const sessionId = await agentStore.spawnSession(
          snapshot.run.root_path ?? fileTreeState.rootPath ?? ".",
          assignment.agent_type,
          { localSessionId, conversationTitle: task.title },
        );
        if (!sessionId) throw new Error("agent session failed to start");
        spawnedSessionId = sessionId;
        ownedSessionIds.set(sessionId, runId);
        agentStore.markSessionRunOwned(sessionId, runId);
        await agentStore.sendPrompt(
          buildTaskPrompt(snapshot.run.objective, task),
          undefined,
          undefined,
          sessionId,
        );
        await waitForTurn(sessionId);
        response = finalAssistantMessage(sessionId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        fallbackDetail = `${assignment.agent_type} local session unavailable; used the signed-in Seren chat model: ${detail}`;
        response = await runSerenChatTask(snapshot.run.objective, task);
      }
    }

    if (fallbackDetail) {
      await recordGap(
        runId,
        task.id,
        "provider_boundary",
        task.title,
        fallbackDetail,
      );
    }

    const parsed = response ? parseAgentFindings(response) : null;
    if (!parsed) {
      await recordGap(
        runId,
        task.id,
        "unparseable",
        task.title,
        "agent response did not contain a valid seren-findings block",
      );
      // Nothing was produced, so there is nothing to verify. Ending the attempt
      // here settles the task instead of parking it in the review lane.
      await runFinishAttempt(runId, attemptId, "parse_failed");
      return;
    }
    for (const finding of parsed.findings) {
      await runRecordFinding(toFinding(runId, task.id, attemptId, finding));
    }
    for (const gap of parsed.coverage_gaps) {
      await runAddCoverageGap(toCoverageGap(runId, task.id, gap));
    }
    await runVerifyTask(runId, task.id);
    // The completion gate decides the attempt's outcome. Recording "completed"
    // before asking would leave a rejected task sitting in review with its
    // reasons discarded and its run unable to finish.
    const blockers = await runCompleteTask(runId, task.id);
    if (blockers.length > 0) {
      await recordGap(
        runId,
        task.id,
        "incomplete_evidence",
        task.title,
        `task did not meet the completion gate: ${blockers.join("; ")}`,
      );
      await runFinishAttempt(runId, attemptId, "failed");
      return;
    }
    await runFinishAttempt(runId, attemptId, "completed");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      await recordGap(runId, task.id, "other", task.title, detail);
      if (attemptId) {
        await runFinishAttempt(runId, attemptId, "failed");
      }
    } catch {
      // Preserve the original dispatch failure; the durable event loop may be stopping.
    }
    // A failure before the attempt exists used to disappear entirely, leaving
    // the task ready and the effect retrying it on every snapshot change.
    reportError("run.task_dispatch_failed", `task ${task.id}: ${detail}`, {
      cause: error,
    });
  } finally {
    // A task owns its agent session for the length of the task. Holding it
    // open afterwards would keep an admission slot and a live CLI process for
    // work that is already finished, starving the next task and any chat the
    // user starts while the run is going.
    if (spawnedSessionId) {
      ownedSessionIds.delete(spawnedSessionId);
      await retireRunSession(spawnedSessionId);
    }
  }
}

async function retireRunSession(sessionId: string): Promise<void> {
  agentStore.releaseSessionRunOwnership(sessionId);
  try {
    await agentStore.terminateSession(sessionId);
  } catch (error) {
    console.warn(
      "[RunDispatcher] Failed to terminate run-owned session:",
      sessionId,
      error,
    );
  }
}

let disposeDispatcher: (() => void) | null = null;
let assignmentCursor = 0;
const inFlightTasks = new Set<string>();
const ownedSessionIds = new Map<string, string>();

function releaseTerminalOwnership(snapshot: RunSnapshot | null): void {
  if (!isTerminalRun(snapshot)) return;
  for (const [sessionId, runId] of ownedSessionIds) {
    if (runId === snapshot?.run.id) {
      ownedSessionIds.delete(sessionId);
      // Stopping a run must stop its agents. Leaving them alive lets a
      // cancelled run keep spending tokens and appending findings to a record
      // the user already closed.
      void retireRunSession(sessionId);
    }
  }
}

export function startRunDispatcher(): void {
  if (disposeDispatcher) return;
  createRoot((dispose) => {
    disposeDispatcher = dispose;
    createEffect(() => {
      const snapshot = runState.snapshot;
      const runId = runState.activeRunId;
      releaseTerminalOwnership(snapshot);
      if (
        !snapshot ||
        !runId ||
        snapshot.run.status === "interrupted" ||
        isTerminalRun(snapshot)
      ) {
        return;
      }
      const plans = selectDispatchPlan(
        snapshot.tasks,
        snapshot.assignments,
        inFlightTasks,
        MAX_CONCURRENT_TASKS,
        assignmentCursor,
        snapshot.attempts,
      );
      assignmentCursor += plans.length;
      for (const plan of plans) {
        inFlightTasks.add(plan.task.id);
        void dispatchTask(
          snapshot,
          plan.task,
          plan.assignment,
          ownedSessionIds,
        ).finally(() => inFlightTasks.delete(plan.task.id));
      }
    });
  });
}

export function stopRunDispatcher(): void {
  disposeDispatcher?.();
  disposeDispatcher = null;
  for (const sessionId of ownedSessionIds.keys()) {
    void retireRunSession(sessionId);
  }
  ownedSessionIds.clear();
  inFlightTasks.clear();
  assignmentCursor = 0;
}
