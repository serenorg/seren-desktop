// ABOUTME: Paired Claude + Codex coordinator — Claude plans/reviews, Codex executes (#2368).
// ABOUTME: Presents one paired session to the frontend; inner runtime events are remapped with role attribution.

import { randomUUID } from "node:crypto";

export const PAIRED_AGENT_TYPE = "claude-codex";

const PAIRED_LEDGER_VERSION = 1;
const DEFAULT_EXECUTOR_MAX_ATTEMPTS = 3;
const DEFAULT_EXECUTOR_TOKEN_BUDGET = 120_000;
const MAX_PERSISTED_PHASES = 8;
const MAX_PERSISTED_TEXT = 32_000;

// Default Claude model for the paired agent's planner/reviewer role. The paired
// agent pins the Claude role to Fable 5 unless the user has explicitly chosen a
// planner model. When the account cannot switch to Fable, the planner falls back
// to the newest Opus (#2827) rather than silently running the Claude default.
// Applied as a post-spawn model switch (see spawnRole), resolved against the
// session's real switchable catalog.
//
// Match on the base id, NOT an exact literal: the Claude Code CLI reports Fable
// in its switchable catalog as `claude-fable-5[1m]` (1M-tier suffix, the same
// shape as its Opus/Sonnet 1M entries), and future builds may date-stamp it. An
// exact bare-id compare silently missed the real `[1m]` entry and demoted every
// Fable-capable account to the Opus fallback with a false "unavailable" notice
// (#2859). Resolve against the normalized base and pin whichever concrete id the
// catalog actually exposes. #2825.
const PAIRED_PLANNER_BASE_MODEL_ID = "claude-fable-5";

// Friendly labels for pinned model ids the Claude Code catalog may not report by
// name, so the setup declaration reads "Fable 5" rather than a raw model id.
const MODEL_DISPLAY_LABELS = {
  "claude-fable-5": "Fable 5",
  "claude-fable-5[1m]": "Fable 5",
};

// Normalize a catalog model id to its base for family matching: drop the 1M-tier
// `[1m]` suffix and any trailing `-YYYYMMDD` date stamp. Mirrors the stripping in
// claude-runtime.mjs's inferClaudeContextWindow so `claude-fable-5[1m]` and a
// dated `claude-fable-5-20260601` both resolve to `claude-fable-5`.
function normalizeBaseModelId(modelId) {
  return typeof modelId === "string"
    ? modelId.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "")
    : "";
}

// Find the account's switchable Fable entry regardless of tier/date suffix.
// Prefer the 1M-tier variant when the catalog lists more than one, so the pin
// lands on Fable's native 1M context.
function findFableModel(availableModels) {
  const fable = availableModels.filter(
    (m) => normalizeBaseModelId(m.modelId) === PAIRED_PLANNER_BASE_MODEL_ID,
  );
  if (fable.length === 0) return null;
  return fable.find((m) => /\[1m\]$/i.test(m.modelId)) ?? fable[0];
}

// When Fable 5 isn't available on the account, the planner falls back to Opus.
// The Claude catalog is sorted opus-first, newest version first, so the first
// Opus entry is the latest; prefer its 1M-context tier (the app default, #2810).
function findFallbackOpus(availableModels) {
  const opus = availableModels.filter(
    (m) => typeof m.modelId === "string" && m.modelId.startsWith("claude-opus-"),
  );
  if (opus.length === 0) return null;
  const newestBaseId = opus[0].modelId.replace(/\[1m\]$/, "");
  return (
    opus.find((m) => m.modelId === `${newestBaseId}[1m]`) ??
    opus.find((m) => m.modelId === newestBaseId) ??
    opus[0]
  );
}

// Resolve which model to pin for the planner given the account's switchable
// catalog. Prefer an explicit user choice, then Fable 5, then the newest Opus.
// Returns a null modelId when none apply so the caller keeps the Claude default.
// The `reason` drives the notice/label so a fallback never claims to be Fable.
export function resolvePlannerModel(explicitModelId, availableModels) {
  if (explicitModelId) {
    return { modelId: explicitModelId, reason: "explicit", name: null };
  }
  const models = Array.isArray(availableModels) ? availableModels : [];
  const fable = findFableModel(models);
  if (fable) {
    return { modelId: fable.modelId, reason: "fable", name: fable.name ?? null };
  }
  const opus = findFallbackOpus(models);
  if (opus) {
    return { modelId: opus.modelId, reason: "opus-fallback", name: opus.name };
  }
  return { modelId: null, reason: "default", name: null };
}

const ROLE_DEFS = {
  planner: {
    role: "planner",
    label: "Claude",
    agentType: "claude-code",
    defaultModelLabel: "Claude Default",
  },
  executor: {
    role: "executor",
    label: "Codex",
    agentType: "codex",
    defaultModelLabel: "Codex Recommended",
  },
};

function modelDisplayName(roleState) {
  const id = roleState.models?.currentModelId;
  if (!id) return null;
  const match = (roleState.models?.availableModels ?? []).find(
    (m) => m.modelId === id,
  );
  return match?.name ?? id;
}

function effortDisplayValue(roleState) {
  const option = (roleState.configOptions ?? []).find(
    (o) => o.id === "reasoning_effort",
  );
  return option?.currentValue ?? null;
}

function describeRoleModel(roleState) {
  const base = roleState.pinnedModelId
    ? (modelDisplayName(roleState) ??
        MODEL_DISPLAY_LABELS[roleState.pinnedModelId] ??
        roleState.pinnedModelId)
    : ROLE_DEFS[roleState.role].defaultModelLabel;
  const current = modelDisplayName(roleState);
  return current && current !== base ? `${base} · currently ${current}` : base;
}

export function buildPairedDeclaration(paired) {
  const planner = paired.roles.planner;
  const executor = paired.roles.executor;
  const plannerEffort = effortDisplayValue(planner) ?? "runtime default";
  const executorEffort = effortDisplayValue(executor) ?? "runtime default";
  return [
    "**Setup**",
    "",
    "- Claude is planner and reviewer.",
    "- Codex is executor for code edits, commands, and tests.",
    `- Planner: ${describeRoleModel(planner)} · ${plannerEffort} effort.`,
    `- Executor: ${describeRoleModel(executor)} · ${executorEffort} effort.`,
    "- Handoffs appear inline when ownership changes.",
  ].join("\n");
}

// A planner turn ends with this control token when the plan is NOT ready to
// hand to the executor — the user asked to keep discussing or designing first,
// asked to withhold execution, or the request needs a clarifying question. When
// present, the coordinator returns control to the user instead of handing off
// to Codex (#2880). The token is stripped from the streamed planner text so it
// never renders to the user.
const PLANNER_HOLD_SENTINEL = "[[PAIRED:AWAIT_USER]]";

// Streaming-safe removal of a fixed control token from a text stream. The token
// can arrive split across chunks, so each push() emits everything that cannot
// be part of the token and holds back a trailing prefix until later text
// decides it. `found` flips true once a complete token has been seen.
function createSentinelFilter(sentinel) {
  let pending = "";
  let found = false;
  const heldPrefixLen = () => {
    const max = Math.min(pending.length, sentinel.length - 1);
    for (let n = max; n > 0; n--) {
      if (sentinel.startsWith(pending.slice(pending.length - n))) return n;
    }
    return 0;
  };
  return {
    push(text) {
      pending += text ?? "";
      let idx = pending.indexOf(sentinel);
      while (idx !== -1) {
        found = true;
        pending = pending.slice(0, idx) + pending.slice(idx + sentinel.length);
        idx = pending.indexOf(sentinel);
      }
      const keep = pending.length - heldPrefixLen();
      const out = pending.slice(0, keep);
      pending = pending.slice(keep);
      return out;
    },
    flush() {
      const out = pending;
      pending = "";
      return out;
    },
    get found() {
      return found;
    },
  };
}

function buildPlannerPrompt(userPrompt) {
  return [
    "You are the PLANNER in a paired workflow. A separate executor agent",
    "(Codex) will make all code edits, run commands, and run tests — you do",
    "not. Read only the files you need to write an accurate plan.",
    "",
    "If the user is not ready for execution — they asked you to discuss,",
    "design, or scope the work before any code changes, asked you to hold off",
    "handing to the executor, or the request needs a clarifying question — then",
    "do NOT write an implementation plan. Respond to the user directly (ask",
    "your question or share the discussion, one point at a time when they ask",
    "for that), and end your entire message with this exact control line on its",
    `own line: ${PLANNER_HOLD_SENTINEL}`,
    "The control line keeps ownership with you so the executor never starts;",
    "the user does not see it. Use it every turn you need to keep talking.",
    "",
    "Otherwise the request is ready to build. Reply with the implementation plan and nothing else:",
    "numbered steps the executor can follow, each naming the concrete file",
    "paths and functions to change. Skip preamble, restating the request,",
    "rationale, alternatives you weighed, and risk commentary — the executor",
    "needs the steps, not the reasoning. Do not include the control line when",
    "you hand off a plan.",
    "",
    "Finish the plan with machine-checkable acceptance assertions, one per line:",
    "ASSERT A1: <observable condition and exact verification evidence required>",
    "ASSERT A2: <observable condition and exact verification evidence required>",
    "Then declare the bounded executor budget on one line:",
    `BUDGET executor_tokens=${DEFAULT_EXECUTOR_TOKEN_BUDGET} max_attempts=${DEFAULT_EXECUTOR_MAX_ATTEMPTS}`,
    "Assertions are the checkpoint contract. Do not replace them with prose.",
    "",
    "User request:",
    userPrompt,
  ].join("\n");
}

function buildExecutorPrompt(userPrompt, planText, phase) {
  const assertionLines = phase.assertions
    .map((assertion) => `${assertion.id}: ${assertion.description}`)
    .join("\n");
  return [
    "You are the EXECUTOR in a paired workflow. Claude's plan is approved",
    "guidance, but the repository is the source of truth. Inspect the",
    "relevant files, callers, tests, and config before editing. If the plan",
    "conflicts with the code, adapt and report the deviation.",
    "",
    "Make the code changes needed to satisfy the user's request end-to-end.",
    "Preserve unrelated user work and do not revert unrelated changes.",
    "Before a phase that depends on external services or credentials, preflight",
    "all named dependencies in one batch. Check non-interactive auth/status,",
    "stored session expiry, publisher access, and fuzzy-match vault entries.",
    "Consolidate every failure into one operator ask; do not discover or report",
    "credential blockers serially. Prefer scoped API tokens when supported.",
    "If an interactive login stalls, capture visible error text and a screenshot",
    "and check the relevant inbox for a verification code before reporting it",
    "blocked. Report authorization/allowlist rejection separately from absence.",
    "",
    "Run focused verification first, then broader impacted lint, typecheck,",
    "build, and test checks when available. Diagnose and fix failures unless",
    "blocked by missing secrets, unavailable external state, or evidence of a",
    "pre-existing failure.",
    "",
    "If third-party services are relevant, call list_agent_publishers with no",
    "arguments once per task, cache that result, and filter it client-side.",
    "Never infer absence from a failed/empty parameterized lookup.",
    "",
    "Before reporting a checkpoint complete, self-verify the produced artifact,",
    "not merely the generator return value: reopen/read it, validate per-unit",
    "content and counts, scan outbound rows/docs for placeholders (example.com,",
    "test@, lorem text, or empty required fields), and block success if found.",
    "For claim-checking work, emit one PASS/FAIL with an evidence reference per",
    "claim and fail category/quantity mismatches. State every coverage bound",
    "(page, top-N, sample, date range); silent truncation is a failed checkpoint.",
    "",
    `This is ledger phase ${phase.id}. You have at most ${phase.budget.maxAttempts}`,
    `attempts and ${phase.budget.executorTokens} executor tokens across the phase.`,
    "Never repeat an approval-gated, destructive, live-send, or non-idempotent",
    "action within this turn. If one needs another attempt, report a BLOCKER",
    "and wait for a fresh operator instruction.",
    "",
    "Report only: changed files, verification commands/results, plan",
    "deviations, and remaining risks/blockers. Finish with exactly one evidence",
    "line for every assertion using `PASS <id> — <evidence>` or",
    "`FAIL <id> — <diagnostics>`. Evidence must name the command, artifact,",
    "or live result checked. Add `ARTIFACT <path-or-url> — <verification>` for",
    "each produced artifact and `BLOCKER <operator action> — <diagnostics>`",
    "for each unresolved blocker. Do not claim the checkpoint complete when",
    "any assertion is missing or failed.",
    "",
    "Ledger assertions:",
    assertionLines || "A1: Satisfy and verify the original user request.",
    "",
    "Original user request:",
    userPrompt,
    "",
    "Approved plan from Claude:",
    planText || "(The planner did not produce plan text; use the user request directly.)",
  ].join("\n");
}

function buildRepairPrompt(userPrompt, planText, phase, diagnostics) {
  return [
    buildExecutorPrompt(userPrompt, planText, phase),
    "",
    `This is bounded repair attempt ${phase.attempts.length + 1}.`,
    "Repair only the failed or missing assertions below, then re-run their",
    "checks. Preserve already verified work. Do not invoke the planner and do",
    "not repeat any approval-gated, destructive, live-send, or non-idempotent",
    "action from an earlier attempt.",
    "",
    "Accumulated diagnostics:",
    diagnostics,
  ].join("\n");
}

function buildReviewPrompt(userPrompt, executorReport, checkpointSummary) {
  return [
    "You are the REVIEWER in a paired workflow. Codex (the executor) just",
    "implemented your plan. Review the work below against the user's request.",
    "Do NOT edit files. Verify the changes look correct, call out any gaps or",
    "risks, and finish with a short summary for the user: who planned, what",
    "changed, who reviewed, and test status. This is a declared checkpoint",
    "invocation. Reference the ledger phase/assertion ids; do not restate the",
    "canonical plan. The runtime appends the final post-review spend line; use",
    "the current spend snapshot below only as review context.",
    "",
    checkpointSummary,
    "",
    "Original user request:",
    userPrompt,
    "",
    "Executor report from Codex:",
    executorReport || "(The executor did not produce a report.)",
  ].join("\n");
}

function mergeUsage(target, meta) {
  const usage = meta?.usage;
  if (!usage) return;
  target.input_tokens += usage.input_tokens ?? 0;
  target.output_tokens += usage.output_tokens ?? 0;
}

function emptySpend() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    turns: 0,
    cost_usd: 0,
    costed_turns: 0,
  };
}

function usageFromMeta(meta) {
  const cost = Number(meta?.cost_usd);
  return {
    input_tokens: Number(meta?.usage?.input_tokens) || 0,
    output_tokens: Number(meta?.usage?.output_tokens) || 0,
    turns: 1,
    cost_usd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
    costed_turns: Number.isFinite(cost) && cost >= 0 ? 1 : 0,
  };
}

function addSpend(target, delta) {
  target.input_tokens += delta.input_tokens;
  target.output_tokens += delta.output_tokens;
  target.turns += delta.turns;
  target.cost_usd += delta.cost_usd;
  target.costed_turns += delta.costed_turns;
}

function totalTokens(spend) {
  return spend.input_tokens + spend.output_tokens;
}

function createLedger() {
  return {
    version: PAIRED_LEDGER_VERSION,
    sequence: 0,
    canonicalPlan: null,
    phases: [],
    totalSpend: {
      planner: emptySpend(),
      executor: emptySpend(),
    },
    plannerInvocations: [],
  };
}

function normalizeSpend(raw) {
  return {
    input_tokens: Number(raw?.input_tokens) || 0,
    output_tokens: Number(raw?.output_tokens) || 0,
    turns: Number(raw?.turns) || 0,
    cost_usd: Number(raw?.cost_usd) || 0,
    costed_turns: Number(raw?.costed_turns) || 0,
  };
}

function normalizeBudget(raw) {
  return {
    executorTokens: Math.min(
      500_000,
      Math.max(1, Number(raw?.executorTokens) || DEFAULT_EXECUTOR_TOKEN_BUDGET),
    ),
    maxAttempts: Math.min(
      5,
      Math.max(1, Number(raw?.maxAttempts) || DEFAULT_EXECUTOR_MAX_ATTEMPTS),
    ),
  };
}

function normalizeLedger(raw) {
  if (!raw || raw.version !== PAIRED_LEDGER_VERSION) return createLedger();
  return {
    ...createLedger(),
    ...raw,
    phases: Array.isArray(raw.phases)
      ? raw.phases.map((phase) => ({
          ...phase,
          assertions: Array.isArray(phase.assertions) ? phase.assertions : [],
          attempts: Array.isArray(phase.attempts) ? phase.attempts : [],
          artifacts: Array.isArray(phase.artifacts) ? phase.artifacts : [],
          blockers: Array.isArray(phase.blockers) ? phase.blockers : [],
          budget: normalizeBudget(phase.budget),
          spend: {
            planner: normalizeSpend(phase.spend?.planner),
            executor: normalizeSpend(phase.spend?.executor),
          },
        }))
      : [],
    totalSpend: {
      planner: normalizeSpend(raw.totalSpend?.planner),
      executor: normalizeSpend(raw.totalSpend?.executor),
    },
    plannerInvocations: Array.isArray(raw.plannerInvocations)
      ? raw.plannerInvocations.slice(-40)
      : [],
  };
}

function persistedLedger(ledger) {
  const copy = JSON.parse(JSON.stringify(ledger));
  copy.canonicalPlan = String(copy.canonicalPlan ?? "").slice(
    0,
    MAX_PERSISTED_TEXT,
  );
  const phases = (copy.phases ?? []).slice(-MAX_PERSISTED_PHASES);
  copy.phases = phases.map((phase, index) => ({
    ...phase,
    userPrompt: String(phase.userPrompt ?? "").slice(0, 2_000),
    lastExecutorReport:
      index === phases.length - 1
        ? String(phase.lastExecutorReport ?? "").slice(0, MAX_PERSISTED_TEXT)
        : "",
    attempts: (phase.attempts ?? []).map((attempt) => ({
      ...attempt,
      diagnostics: String(attempt.diagnostics ?? "").slice(0, 1_500),
    })),
  }));
  copy.plannerInvocations = (copy.plannerInvocations ?? []).slice(-40);
  return copy;
}

function parseResumeState(raw) {
  if (!raw) return { resumeIds: null, ledger: createLedger() };
  try {
    const parsed = JSON.parse(raw);
    return {
      resumeIds: parsed && typeof parsed === "object" ? parsed : null,
      ledger: normalizeLedger(parsed?.ledger),
    };
  } catch {
    return { resumeIds: null, ledger: createLedger() };
  }
}

function parsePlanContract(planText) {
  const assertions = [];
  const seen = new Set();
  const assertionPattern = /^\s*ASSERT\s+([A-Za-z0-9._-]+)\s*:\s*(.+)$/gim;
  let match;
  while ((match = assertionPattern.exec(planText)) !== null) {
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    assertions.push({ id, description: match[2].trim() });
  }
  if (assertions.length === 0) {
    assertions.push({
      id: "A1",
      description: "Satisfy and verify the original user request.",
    });
  }

  const budgetMatch =
    /^\s*BUDGET\s+executor_tokens=(\d+)\s+max_attempts=(\d+)\s*$/im.exec(
      planText,
    );
  const executorTokens = Math.min(
    500_000,
    Math.max(1, Number(budgetMatch?.[1]) || DEFAULT_EXECUTOR_TOKEN_BUDGET),
  );
  const maxAttempts = Math.min(
    5,
    Math.max(1, Number(budgetMatch?.[2]) || DEFAULT_EXECUTOR_MAX_ATTEMPTS),
  );
  return { assertions, budget: { executorTokens, maxAttempts } };
}

function parseExecutorReport(report, assertions) {
  const resultById = new Map();
  const resultPattern =
    /^\s*(PASS|FAIL)\s+([A-Za-z0-9._-]+)\s*(?:—|-|:)\s*(.+)$/gim;
  let match;
  while ((match = resultPattern.exec(report)) !== null) {
    resultById.set(match[2].toUpperCase(), {
      id: match[2].toUpperCase(),
      passed: match[1].toUpperCase() === "PASS",
      evidence: match[3].trim(),
    });
  }
  const results = assertions.map((assertion) => {
    const result = resultById.get(assertion.id);
    return (
      result ?? {
        id: assertion.id,
        passed: false,
        evidence: "Missing PASS/FAIL evidence line.",
      }
    );
  });

  const artifacts = [];
  const artifactPattern = /^\s*ARTIFACT\s+(.+?)(?:\s+(?:—|-|:)\s+(.+))?$/gim;
  while ((match = artifactPattern.exec(report)) !== null) {
    artifacts.push({ path: match[1].trim(), verification: match[2]?.trim() ?? "" });
  }
  const blockers = [];
  const blockerPattern = /^\s*BLOCKER\s+(.+?)(?:\s+(?:—|-|:)\s+(.+))?$/gim;
  while ((match = blockerPattern.exec(report)) !== null) {
    blockers.push({ action: match[1].trim(), diagnostics: match[2]?.trim() ?? "" });
  }
  const failed = results.filter((result) => !result.passed);
  const diagnostics = [
    ...failed.map((result) => `${result.id}: ${result.evidence}`),
    ...blockers.map(
      (blocker) => `BLOCKER ${blocker.action}: ${blocker.diagnostics}`,
    ),
  ].join("\n");
  return {
    complete: failed.length === 0 && blockers.length === 0,
    results,
    artifacts,
    blockers,
    diagnostics: diagnostics || "No failed assertion diagnostics were reported.",
  };
}

function substantiallyReemits(previous, next) {
  const words = (value) =>
    new Set(String(value ?? "").toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? []);
  const before = words(previous);
  const after = words(next);
  if (before.size < 20 || after.size < 20) return false;
  let overlap = 0;
  for (const word of before) {
    if (after.has(word)) overlap += 1;
  }
  return overlap / Math.min(before.size, after.size) >= 0.85;
}

function isNonRetryableToolCall(payload) {
  const text = `${payload?.title ?? ""} ${JSON.stringify(
    payload?.parameters ?? {},
  )}`.toLowerCase();
  return (
    /\b(send|deploy|publish|transfer|withdraw|trade|order|payment|delete|remove)\b/.test(
      text,
    ) || /"method"\s*:\s*"(post|put|patch|delete)"/i.test(text)
  );
}

function spendSummary(ledger, phase) {
  const describe = (spend) => {
    const cost =
      spend.costed_turns === spend.turns && spend.turns > 0
        ? `, $${spend.cost_usd.toFixed(6)}`
        : ", cost unavailable from local CLI";
    return `${totalTokens(spend)} tokens (${spend.turns} turns${cost})`;
  };
  return `Ledger ${phase.id} spend: planner ${describe(phase.spend.planner)}, executor ${describe(phase.spend.executor)}; session totals: planner ${describe(ledger.totalSpend.planner)}, executor ${describe(ledger.totalSpend.executor)}.`;
}

function attemptSummary(phase) {
  const outcomes = phase.attempts
    .map((attempt) => `${attempt.number} ${attempt.status}`)
    .join(", ");
  return `Ledger ${phase.id} attempts: ${phase.attempts.length}${
    outcomes ? ` (${outcomes})` : ""
  }.`;
}

function checkpointContext(ledger, phase) {
  const diagnostics = phase.attempts
    .filter((attempt) => attempt.status !== "passed")
    .map((attempt) => `Attempt ${attempt.number}: ${attempt.diagnostics}`)
    .join("\n");
  const blockers = phase.blockers
    .map((blocker) => `${blocker.action}: ${blocker.diagnostics}`)
    .join("\n");
  return [
    attemptSummary(phase),
    spendSummary(ledger, phase),
    diagnostics ? `Accumulated diagnostics:\n${diagnostics}` : "",
    blockers ? `Open blockers:\n${blockers}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function mergeArtifacts(existing, incoming) {
  const byPath = new Map(existing.map((artifact) => [artifact.path, artifact]));
  for (const artifact of incoming) byPath.set(artifact.path, artifact);
  return [...byPath.values()];
}

export function createPairedRuntime({ emit, inner }) {
  const pairedSessions = new Map();
  const innerToPaired = new Map();

  function createRoleState(role) {
    return {
      ...ROLE_DEFS[role],
      innerSessionId: null,
      agentSessionId: null,
      models: undefined,
      configOptions: undefined,
      pinnedModelId: null,
      pinnedEffort: null,
      pinnedServiceTier: null,
      notice: null,
      turnText: "",
      lastTurnMeta: null,
      holdRequested: false,
      sentinelFilter: null,
      permissionRequestsDuringTurn: 0,
      nonRetryableActionsDuringTurn: 0,
    };
  }

  function compositeAgentSessionId(paired) {
    const planner = paired.roles.planner.agentSessionId;
    const executor = paired.roles.executor.agentSessionId;
    if (!planner && !executor) return undefined;
    return JSON.stringify({
      planner,
      executor,
      ledger: persistedLedger(paired.ledger),
    });
  }

  function activeLedgerPhase(paired) {
    for (let index = paired.ledger.phases.length - 1; index >= 0; index -= 1) {
      const phase = paired.ledger.phases[index];
      if (!["completed", "blocked", "interrupted"].includes(phase.status)) {
        return phase;
      }
    }
    return null;
  }

  // A resumable phase (executing/reviewing) that is abandoned by cancel or an
  // in-process error must be retired, or the user's next prompt satisfies the
  // resume gate and is silently swallowed as a re-run of the old task (#2917).
  // Cross-process resume is unaffected: a hard crash never runs this path, so a
  // persisted executing phase still resumes on the next spawn. Planning and
  // awaiting-user phases are left intact so planner-hold continuation survives.
  function markActivePhaseInterrupted(paired) {
    const phase = activeLedgerPhase(paired);
    if (phase && (phase.status === "executing" || phase.status === "reviewing")) {
      phase.status = "interrupted";
    }
  }

  function createLedgerPhase(paired, userPrompt) {
    paired.ledger.sequence += 1;
    const phase = {
      id: `phase-${paired.ledger.sequence}`,
      status: "planning",
      userPrompt,
      planVersion: paired.ledger.sequence,
      assertions: [],
      budget: {
        executorTokens: DEFAULT_EXECUTOR_TOKEN_BUDGET,
        maxAttempts: DEFAULT_EXECUTOR_MAX_ATTEMPTS,
      },
      attempts: [],
      spend: {
        planner: emptySpend(),
        executor: emptySpend(),
      },
      artifacts: [],
      blockers: [],
      lastExecutorReport: "",
      checkpoint: null,
    };
    paired.ledger.phases.push(phase);
    return phase;
  }

  function recordRoleSpend(paired, phase, role) {
    const delta = usageFromMeta(paired.roles[role].lastTurnMeta);
    addSpend(phase.spend[role], delta);
    addSpend(paired.ledger.totalSpend[role], delta);
    return delta;
  }

  function recordPlannerInvocation(paired, phase, kind, outcome, extra = {}) {
    paired.ledger.plannerInvocations.push({
      phaseId: phase.id,
      kind,
      outcome,
      at: new Date().toISOString(),
      ...extra,
    });
    paired.ledger.plannerInvocations = paired.ledger.plannerInvocations.slice(-40);
  }

  function ledgerStatusView(paired) {
    const phase = activeLedgerPhase(paired) ?? paired.ledger.phases.at(-1) ?? null;
    return {
      version: paired.ledger.version,
      phaseId: phase?.id ?? null,
      phaseStatus: phase?.status ?? null,
      attemptCount: phase?.attempts?.length ?? 0,
      spend: phase ? spendSummary(paired.ledger, phase) : null,
    };
  }

  function roleStatusView(roleState) {
    return {
      role: roleState.role,
      label: roleState.label,
      agentType: roleState.agentType,
      defaultModelLabel: roleState.defaultModelLabel,
      models: roleState.models,
      configOptions: roleState.configOptions,
      pinnedModelId: roleState.pinnedModelId,
      pinnedEffort: roleState.pinnedEffort,
      pinnedServiceTier: roleState.pinnedServiceTier,
      notice: roleState.notice,
    };
  }

  function emitPairedStatus(paired, status = paired.status) {
    emit("provider://session-status", {
      sessionId: paired.id,
      status,
      agentSessionId: compositeAgentSessionId(paired),
      agentInfo: { name: "Claude + Codex", version: "paired" },
      paired: {
        state: paired.state,
        activeRole: paired.activeRole,
        planner: roleStatusView(paired.roles.planner),
        executor: roleStatusView(paired.roles.executor),
        ledger: ledgerStatusView(paired),
      },
    });
  }

  function emitDeclaration(paired, { replace = false } = {}) {
    paired.declarationEmitted = true;
    emit("provider://paired-event", {
      sessionId: paired.id,
      kind: "declaration",
      messageId: `paired-declaration-${paired.id}`,
      text: buildPairedDeclaration(paired),
      replace,
    });
  }

  function refreshDeclaration(paired) {
    if (!paired.declarationEmitted) return;
    emitDeclaration(paired, { replace: true });
  }

  function emitHandoff(paired, from, to, text) {
    emit("provider://paired-event", {
      sessionId: paired.id,
      kind: "handoff",
      messageId: randomUUID(),
      text,
      from,
      to,
    });
  }

  function setPhase(paired, state, activeRole) {
    paired.state = state;
    paired.activeRole = activeRole;
    emitPairedStatus(paired);
  }

  function roleForInner(innerSessionId) {
    return innerToPaired.get(innerSessionId) ?? null;
  }

  /**
   * Intercepts every runtime emit. Returns true when the event belonged to a
   * paired inner session and was consumed (re-emitted remapped, captured, or
   * suppressed). providers.mjs forwards untouched events when this returns
   * false, so non-paired sessions are unaffected.
   */
  function interceptEmit(channel, payload) {
    const route = roleForInner(payload?.sessionId);
    if (!route) return false;
    const paired = pairedSessions.get(route.pairedId);
    if (!paired) return false;
    // Teardown in flight: swallow every inner emission so raw inner session
    // ids never reach the frontend during terminate (#2373).
    if (paired.terminating) return true;
    const roleState = paired.roles[route.role];

    switch (channel) {
      case "provider://session-status": {
        let meaningfulChange = false;
        if (payload.models) {
          meaningfulChange =
            meaningfulChange ||
            JSON.stringify(payload.models) !== JSON.stringify(roleState.models);
          roleState.models = payload.models;
        }
        if (payload.configOptions) {
          meaningfulChange =
            meaningfulChange ||
            JSON.stringify(payload.configOptions) !==
              JSON.stringify(roleState.configOptions);
          roleState.configOptions = payload.configOptions;
        }
        if (
          payload.agentSessionId &&
          payload.agentSessionId !== roleState.agentSessionId
        ) {
          roleState.agentSessionId = payload.agentSessionId;
          meaningfulChange = true;
        }
        if (payload.status === "terminated" && !paired.terminating) {
          emit("provider://error", {
            sessionId: paired.id,
            error: `${roleState.label} stopped unexpectedly. Send a new message to restart the paired workflow.`,
          });
          paired.state = "idle";
          paired.activeRole = null;
          emitPairedStatus(paired, "error");
          return true;
        }
        if (meaningfulChange) {
          refreshDeclaration(paired);
          emitPairedStatus(paired);
        }
        return true;
      }

      case "provider://prompt-complete": {
        roleState.lastTurnMeta = payload.meta ?? null;
        return true;
      }

      case "provider://message-chunk": {
        if (payload.replay === true) return true;
        const filter = roleState.sentinelFilter;
        if (filter && !payload.isThought) {
          // Planner visible text: strip the hold control token before it
          // streams so the user never sees it (#2880). Thoughts bypass the
          // filter — the token only appears in the final answer.
          const visible = filter.push(payload.text ?? "");
          roleState.turnText += visible;
          if (visible) {
            emit(channel, {
              ...payload,
              text: visible,
              sessionId: paired.id,
              agentProvider: roleState.agentType,
            });
          }
          return true;
        }
        if (!payload.isThought) {
          roleState.turnText += payload.text ?? "";
        }
        emit(channel, {
          ...payload,
          sessionId: paired.id,
          agentProvider: roleState.agentType,
        });
        return true;
      }

      case "provider://user-message":
        // Synthetic role prompts and replayed history must not surface as
        // user bubbles — the paired thread's user messages come from Seren.
        return true;

      case "provider://permission-request": {
        roleState.permissionRequestsDuringTurn += 1;
        paired.permissionRoutes.set(payload.requestId, payload.sessionId);
        if (paired.state !== "waiting-approval") {
          paired.stateBeforeApproval = {
            state: paired.state,
            activeRole: paired.activeRole,
          };
          paired.state = "waiting-approval";
          emitPairedStatus(paired);
        }
        emit(channel, { ...payload, sessionId: paired.id });
        return true;
      }

      case "provider://tool-call": {
        if (isNonRetryableToolCall(payload)) {
          roleState.nonRetryableActionsDuringTurn += 1;
        }
        emit(channel, {
          ...payload,
          sessionId: paired.id,
          agentProvider: roleState.agentType,
        });
        return true;
      }

      case "provider://error": {
        const message = String(payload.error ?? "");
        if (paired.cancelRequested && message.includes("Task cancelled")) {
          return true;
        }
        emit(channel, { ...payload, sessionId: paired.id });
        return true;
      }

      case "provider://login-required": {
        // Keep the inner agentType so the auto-login flow targets the right CLI.
        emit(channel, { ...payload, sessionId: paired.id });
        return true;
      }

      default:
        emit(channel, {
          ...payload,
          sessionId: paired.id,
          agentProvider: roleState.agentType,
        });
        return true;
    }
  }

  async function spawnRole(paired, role, params, pairedConfig) {
    const roleState = paired.roles[role];
    const innerSessionId = randomUUID();
    roleState.innerSessionId = innerSessionId;
    innerToPaired.set(innerSessionId, { pairedId: paired.id, role });

    const resume = paired.resumeIds?.[role] ?? null;
    const config = pairedConfig?.[role] ?? {};
    roleState.pinnedModelId = config.modelId ?? null;
    roleState.pinnedEffort = config.effort ?? null;

    const base = {
      cwd: params.cwd,
      localSessionId: innerSessionId,
      resumeAgentSessionId: resume,
      apiKey: params.apiKey,
      mcpServers: params.mcpServers,
      timeoutSecs: params.timeoutSecs,
    };

    if (role === "planner") {
      const info = await inner.spawnSession({
        ...base,
        agentType: ROLE_DEFS.planner.agentType,
        approvalPolicy: params.approvalPolicy,
        reasoningEffort: config.effort ?? params.reasoningEffort,
        initialModelId: config.modelId ?? undefined,
      });
      roleState.agentSessionId = info?.agentSessionId ?? roleState.agentSessionId;

      // Pin the planner/reviewer model. Prefer the user's explicit choice, then
      // Fable 5 (#2825), then the newest Opus when the account has no Fable
      // access (#2827). Resolve against the session's real switchable catalog
      // instead of assuming setSessionModel throws on a miss — the Claude path
      // does not throw for an unavailable id, so a blind pin would silently run
      // the wrong model while claiming Fable. Switch after spawn so the process
      // stays on the Claude default first; pinnedModelId/notice always reflect
      // the model actually pinned, never a Fable claim while running Opus.
      const availableModels =
        typeof inner.listSessionModels === "function"
          ? (inner.listSessionModels(innerSessionId) ?? [])
          : [];
      const target = resolvePlannerModel(config.modelId, availableModels);
      if (target.modelId) {
        try {
          await inner.setSessionModel({
            sessionId: innerSessionId,
            modelId: target.modelId,
          });
          roleState.pinnedModelId = target.modelId;
          roleState.notice =
            target.reason === "opus-fallback"
              ? `Fable 5 is unavailable on this account; planning with ${target.name ?? "Opus"} instead.`
              : null;
        } catch {
          roleState.pinnedModelId = null;
          roleState.notice = `Pinned model ${target.modelId} is unavailable in this Claude Code install. Using the Claude default instead.`;
        }
      } else {
        roleState.pinnedModelId = null;
        roleState.notice =
          "Neither Fable 5 nor an Opus model is available on this account. Using the Claude default instead.";
      }
      return info;
    }

    const info = await inner.spawnSession({
      ...base,
      agentType: ROLE_DEFS.executor.agentType,
      // Match direct Codex sessions: paired executor work should start in
      // Permission Mode: Auto, not inherit Claude's default on-request policy.
      approvalPolicy: "on-failure",
      sandboxMode: params.sandboxMode,
      networkEnabled: params.networkEnabled,
      initialModelId: config.modelId ?? undefined,
      reasoningEffort: config.effort ?? undefined,
      codexDefaultIntent: "paired-executor",
    });
    roleState.agentSessionId = info?.agentSessionId ?? roleState.agentSessionId;

    if (config.modelId) {
      try {
        await inner.setSessionModel({
          sessionId: innerSessionId,
          modelId: config.modelId,
        });
      } catch {
        roleState.pinnedModelId = null;
        roleState.notice = `Pinned model ${config.modelId} is no longer available. Using the Codex default instead.`;
      }
    }
    if (config.effort) {
      try {
        await inner.updateSessionConfigOption({
          sessionId: innerSessionId,
          configId: "reasoning_effort",
          valueId: config.effort,
        });
      } catch {
        roleState.pinnedEffort = null;
        roleState.notice = `Pinned effort ${config.effort} is not supported by the selected Codex model. Using its default effort instead.`;
      }
    }
    if (config.serviceTier) {
      try {
        await inner.updateSessionConfigOption({
          sessionId: innerSessionId,
          configId: "fast_mode",
          valueId: "on",
        });
        roleState.pinnedServiceTier = config.serviceTier;
      } catch {
        roleState.pinnedServiceTier = null;
        roleState.notice = `Pinned Codex service tier ${config.serviceTier} is not supported by the selected model. Using its default speed instead.`;
      }
    }
    return info;
  }

  async function spawnSession(params) {
    const pairedId = params.localSessionId ?? randomUUID();
    const resumeState = parseResumeState(params.resumeAgentSessionId);
    const resumeIds = resumeState.resumeIds;

    const paired = {
      id: pairedId,
      cwd: params.cwd,
      status: "initializing",
      createdAt: new Date().toISOString(),
      timeoutSecs: params.timeoutSecs ?? undefined,
      state: "idle",
      activeRole: null,
      roles: {
        planner: createRoleState("planner"),
        executor: createRoleState("executor"),
      },
      ledger: resumeState.ledger,
      resumeIds,
      currentPrompt: null,
      cancelRequested: false,
      terminating: false,
      declarationEmitted: Boolean(resumeIds),
      permissionRoutes: new Map(),
      stateBeforeApproval: null,
    };
    pairedSessions.set(pairedId, paired);

    try {
      await spawnRole(paired, "planner", params, params.paired);
      await spawnRole(paired, "executor", params, params.paired);

      paired.status = "ready";
      if (!resumeIds) {
        emitDeclaration(paired);
      }
      emitPairedStatus(paired, "ready");

      return {
        id: paired.id,
        agentType: PAIRED_AGENT_TYPE,
        cwd: paired.cwd,
        status: paired.status,
        createdAt: paired.createdAt,
        agentSessionId: compositeAgentSessionId(paired),
        timeoutSecs: paired.timeoutSecs,
        // Two child processes back this session; per-PID force-kill cannot
        // target both, so cancel/terminate are the supported stop paths.
        pid: null,
      };
    } catch (error) {
      paired.terminating = true;
      // Terminate before dropping the route entries so teardown emissions
      // from the inner runtimes stay intercepted (#2373).
      for (const role of Object.values(paired.roles)) {
        if (!role.innerSessionId) continue;
        try {
          await inner.terminateSession({ sessionId: role.innerSessionId });
        } catch {
          // Best-effort teardown — the inner spawn may never have registered.
        }
      }
      for (const role of Object.values(paired.roles)) {
        if (role.innerSessionId) innerToPaired.delete(role.innerSessionId);
      }
      pairedSessions.delete(pairedId);
      const message = error instanceof Error ? error.message : String(error);
      emit("provider://error", { sessionId: pairedId, error: message });
      throw error;
    }
  }

  function requirePaired(sessionId) {
    const paired = pairedSessions.get(sessionId);
    if (!paired) {
      throw new Error(`Paired session not found: ${sessionId}`);
    }
    return paired;
  }

  function throwIfCancelled(paired) {
    if (paired.cancelRequested) {
      const error = new Error("Task cancelled");
      error.pairedCancelled = true;
      throw error;
    }
  }

  async function runRoleTurn(paired, role, prompt, context) {
    const roleState = paired.roles[role];
    roleState.turnText = "";
    roleState.lastTurnMeta = null;
    roleState.holdRequested = false;
    roleState.permissionRequestsDuringTurn = 0;
    roleState.nonRetryableActionsDuringTurn = 0;
    // Only the planner can hold the turn for the user; its control token is
    // stripped from the streamed text as chunks arrive (#2880).
    roleState.sentinelFilter =
      role === "planner" ? createSentinelFilter(PLANNER_HOLD_SENTINEL) : null;
    try {
      await inner.sendPrompt({
        sessionId: roleState.innerSessionId,
        prompt,
        context,
      });
    } finally {
      const filter = roleState.sentinelFilter;
      roleState.sentinelFilter = null;
      if (filter) {
        // Emit any held-back tail (a partial token that never completed) so the
        // last visible characters still reach the UI.
        const tail = filter.flush();
        if (tail && !paired.cancelRequested) {
          roleState.turnText += tail;
          emit("provider://message-chunk", {
            sessionId: paired.id,
            text: tail,
            agentProvider: roleState.agentType,
          });
        }
        roleState.holdRequested = filter.found;
      }
    }
    throwIfCancelled(paired);
    return roleState.turnText;
  }

  async function sendPrompt({ sessionId, prompt, context }) {
    const paired = requirePaired(sessionId);
    if (paired.currentPrompt) {
      throw new Error("Another prompt is already active for this session.");
    }

    paired.cancelRequested = false;
    paired.currentPrompt = {};
    // The whole pipeline is one turn from the frontend's perspective. The
    // composer's Send gate reads info.status, so every status frame emitted
    // during a phase must carry "prompting" — a mid-turn "ready" re-enables
    // Send and the second submit collides with this turn (#2372).
    paired.status = "prompting";
    const usage = { input_tokens: 0, output_tokens: 0 };
    let contextWindow;

    const collectMeta = (role, phase) => {
      const meta = paired.roles[role].lastTurnMeta;
      mergeUsage(usage, meta);
      const delta = recordRoleSpend(paired, phase, role);
      if (typeof meta?.contextWindow === "number") {
        contextWindow = meta.contextWindow;
      }
      return delta;
    };

    try {
      if (!paired.declarationEmitted) {
        emitDeclaration(paired);
      }

      let phase = activeLedgerPhase(paired);
      if (!phase) phase = createLedgerPhase(paired, prompt);
      const resumable =
        Boolean(paired.ledger.canonicalPlan) &&
        ["executing", "reviewing"].includes(phase.status);
      let planText = paired.ledger.canonicalPlan ?? "";

      if (resumable) {
        recordPlannerInvocation(
          paired,
          phase,
          "plan",
          "blocked-resume-routed-to-executor",
        );
        phase.userPrompt = phase.userPrompt || prompt;
        emitPairedStatus(paired);
      } else {
        phase.status = "planning";
        setPhase(paired, "planning", "planner");
        const previousPlan = paired.ledger.canonicalPlan;
        planText = await runRoleTurn(
          paired,
          "planner",
          buildPlannerPrompt(prompt),
          context,
        );
        collectMeta("planner", phase);
        recordPlannerInvocation(paired, phase, "plan", "allowed", {
          duplicatePlan: substantiallyReemits(previousPlan, planText),
        });

        // The planner can hold the turn for the user — a design/discussion phase
        // or a clarifying question — instead of handing off. Keep the phase so
        // its role spend survives, but do not create a canonical plan yet.
        if (paired.roles.planner.holdRequested) {
          phase.status = "awaiting-user";
          paired.currentPrompt = null;
          paired.status = "ready";
          setPhase(paired, "idle", null);
          emit("provider://prompt-complete", {
            sessionId: paired.id,
            stopReason: "end_turn",
            meta: {
              usage,
              ...(contextWindow ? { contextWindow } : {}),
            },
          });
          emitPairedStatus(paired, "ready");
          return;
        }

        const contract = parsePlanContract(planText);
        phase.assertions = contract.assertions;
        phase.budget = contract.budget;
        phase.status = "executing";
        phase.userPrompt = prompt;
        paired.ledger.canonicalPlan = planText;
      }

      let executorReport = phase.lastExecutorReport;
      let checkpoint = phase.checkpoint;
      if (phase.status !== "reviewing" || !executorReport || !checkpoint) {
        emitHandoff(
          paired,
          resumable ? "Ledger" : "Claude",
          "Codex",
          resumable
            ? `${phase.id} resumed directly with Codex; planner re-entry was blocked.`
            : "Claude handed off to Codex to make the approved code changes.",
        );
        phase.status = "executing";
        setPhase(paired, "executing", "executor");

        let executorPrompt =
          phase.attempts.length > 0
            ? buildRepairPrompt(
                phase.userPrompt,
                planText,
                phase,
                phase.attempts
                  .map(
                    (attempt) =>
                      `Attempt ${attempt.number}: ${attempt.diagnostics}`,
                  )
                  .join("\n"),
              )
            : buildExecutorPrompt(phase.userPrompt, planText, phase);
        while (phase.attempts.length < phase.budget.maxAttempts) {
          executorReport = await runRoleTurn(
            paired,
            "executor",
            executorPrompt,
            context,
          );
          const attemptUsage = collectMeta("executor", phase);
          checkpoint = parseExecutorReport(executorReport, phase.assertions);
          phase.lastExecutorReport = executorReport;
          phase.artifacts = mergeArtifacts(phase.artifacts, checkpoint.artifacts);
          phase.blockers = checkpoint.blockers;
          phase.checkpoint = checkpoint;
          phase.attempts.push({
            number: phase.attempts.length + 1,
            status: checkpoint.complete ? "passed" : "failed",
            assertionResults: checkpoint.results,
            diagnostics: checkpoint.diagnostics,
            usage: attemptUsage,
            approvalRequests:
              paired.roles.executor.permissionRequestsDuringTurn,
            nonRetryableActions:
              paired.roles.executor.nonRetryableActionsDuringTurn,
            at: new Date().toISOString(),
          });
          emitPairedStatus(paired);

          if (checkpoint.complete) break;
          if (paired.roles.executor.permissionRequestsDuringTurn > 0) {
            phase.blockers.push({
              action: "Fresh operator approval required before retry",
              diagnostics:
                "Autonomous repair stopped because this attempt crossed an approval gate.",
            });
            break;
          }
          if (paired.roles.executor.nonRetryableActionsDuringTurn > 0) {
            phase.blockers.push({
              action: "Fresh operator instruction required before retry",
              diagnostics:
                "Autonomous repair stopped because this attempt performed a live-write, destructive, or non-idempotent action.",
            });
            break;
          }
          if (totalTokens(phase.spend.executor) >= phase.budget.executorTokens) {
            phase.blockers.push({
              action: "Executor token budget exhausted",
              diagnostics: `${totalTokens(phase.spend.executor)} / ${phase.budget.executorTokens} tokens used.`,
            });
            break;
          }
          if (phase.attempts.length >= phase.budget.maxAttempts) break;
          executorPrompt = buildRepairPrompt(
            phase.userPrompt,
            planText,
            phase,
            phase.attempts
              .map(
                (attempt) =>
                  `Attempt ${attempt.number}: ${attempt.diagnostics}`,
              )
              .join("\n"),
          );
        }
      }

      emitHandoff(
        paired,
        "Codex",
        "Claude",
        "Codex handed back to Claude at the declared ledger checkpoint.",
      );
      phase.status = "reviewing";
      setPhase(paired, "reviewing", "planner");
      recordPlannerInvocation(paired, phase, "checkpoint", "allowed");
      await runRoleTurn(
        paired,
        "planner",
        buildReviewPrompt(
          phase.userPrompt,
          executorReport,
          checkpointContext(paired.ledger, phase),
        ),
      );
      collectMeta("planner", phase);
      phase.status = checkpoint?.complete ? "completed" : "blocked";
      const finalSpendSummary = spendSummary(paired.ledger, phase);
      emit("provider://message-chunk", {
        sessionId: paired.id,
        text: `\n\n${attemptSummary(phase)}\n${finalSpendSummary}`,
        agentProvider: paired.roles.planner.agentType,
      });
      emitPairedStatus(paired);

      paired.currentPrompt = null;
      paired.status = "ready";
      setPhase(paired, "idle", null);
      emit("provider://prompt-complete", {
        sessionId: paired.id,
        stopReason: "end_turn",
        meta: {
          usage,
          ...(contextWindow ? { contextWindow } : {}),
        },
      });
      emitPairedStatus(paired, "ready");
    } catch (error) {
      paired.currentPrompt = null;
      const message = error instanceof Error ? error.message : String(error);
      const wasCancelled =
        paired.cancelRequested || message.includes("Task cancelled");
      paired.status = "ready";
      paired.state = "idle";
      paired.activeRole = null;
      markActivePhaseInterrupted(paired);
      if (wasCancelled) {
        // cancelPrompt already emitted the cancel error + ready status.
        // Reject like the single-session runtimes so the frontend's prompt
        // RPC unwinds the same way for every agent type.
        throw error instanceof Error ? error : new Error("Task cancelled");
      }
      emitPairedStatus(paired, "ready");
      throw error;
    }
  }

  async function cancelPrompt({ sessionId }) {
    const paired = requirePaired(sessionId);
    paired.cancelRequested = true;

    const activeRole = paired.activeRole;
    if (activeRole) {
      const innerSessionId = paired.roles[activeRole].innerSessionId;
      try {
        await inner.cancelPrompt({ sessionId: innerSessionId });
      } catch {
        // The inner runtime escalates to a hard kill itself; keep going so
        // the paired turn still unwinds.
      }
    }

    paired.status = "ready";
    paired.state = "idle";
    paired.activeRole = null;
    markActivePhaseInterrupted(paired);
    emit("provider://error", {
      sessionId: paired.id,
      error: "Task cancelled",
    });
    emitPairedStatus(paired, "ready");
  }

  async function terminateSession({ sessionId }) {
    const paired = requirePaired(sessionId);
    paired.terminating = true;

    // Inner runtimes emit their own terminated statuses while teardown is
    // in flight. Keep the route entries (and the paired record) alive until
    // both inner sessions are down so those emits stay intercepted — the
    // terminating flag swallows them (#2373).
    for (const role of Object.values(paired.roles)) {
      if (!role.innerSessionId) continue;
      try {
        await inner.terminateSession({ sessionId: role.innerSessionId });
      } catch {
        // Best-effort: one inner session may already be gone.
      }
    }

    for (const role of Object.values(paired.roles)) {
      if (role.innerSessionId) innerToPaired.delete(role.innerSessionId);
    }
    pairedSessions.delete(sessionId);

    emit("provider://session-status", {
      sessionId: paired.id,
      status: "terminated",
      agentSessionId: compositeAgentSessionId(paired),
    });
  }

  async function listSessions() {
    return Array.from(pairedSessions.values()).map((paired) => ({
      id: paired.id,
      agentType: PAIRED_AGENT_TYPE,
      cwd: paired.cwd,
      status: paired.status,
      createdAt: paired.createdAt,
      agentSessionId: compositeAgentSessionId(paired),
      timeoutSecs: paired.timeoutSecs,
    }));
  }

  function requireRole(paired, role) {
    if (role !== "planner" && role !== "executor") {
      throw new Error(
        "Paired sessions require an explicit role: planner or executor.",
      );
    }
    return paired.roles[role];
  }

  async function setSessionModel({ sessionId, modelId, role }) {
    const paired = requirePaired(sessionId);
    const roleState = requireRole(paired, role);
    await inner.setSessionModel({
      sessionId: roleState.innerSessionId,
      modelId,
    });
    roleState.pinnedModelId = modelId;
    roleState.notice = null;
    refreshDeclaration(paired);
    emitPairedStatus(paired);
  }

  async function updateSessionConfigOption({
    sessionId,
    configId,
    valueId,
    role,
  }) {
    const paired = requirePaired(sessionId);
    const roleState = requireRole(paired, role);
    await inner.updateSessionConfigOption({
      sessionId: roleState.innerSessionId,
      configId,
      valueId,
    });
    if (configId === "reasoning_effort") {
      roleState.pinnedEffort = valueId;
      roleState.notice =
        role === "planner"
          ? "Planner effort applies from the next planning session Claude spawns."
          : null;
      // Claude re-emits a status with the new effort; Codex emits a
      // config-options-update. Either way the local snapshot keeps the
      // selector responsive until the runtime echo lands.
      const option = (roleState.configOptions ?? []).find(
        (o) => o.id === "reasoning_effort",
      );
      if (option) option.currentValue = valueId;
    }
    if (configId === "fast_mode") {
      roleState.pinnedServiceTier = valueId === "on" ? "fast" : null;
      const option = (roleState.configOptions ?? []).find(
        (o) => o.id === "fast_mode",
      );
      if (option) option.currentValue = valueId;
    }
    refreshDeclaration(paired);
    emitPairedStatus(paired);
    return null;
  }

  async function setPermissionMode({ sessionId, mode }) {
    const paired = requirePaired(sessionId);
    // The executor performs the edits/commands — approval mode belongs to it.
    await inner.setPermissionMode({
      sessionId: paired.roles.executor.innerSessionId,
      mode,
    });
    emitPairedStatus(paired);
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const paired = requirePaired(sessionId);
    const innerSessionId = paired.permissionRoutes.get(requestId);
    if (!innerSessionId) {
      throw new Error(`No pending permission request: ${requestId}`);
    }
    paired.permissionRoutes.delete(requestId);
    await inner.respondToPermission({
      sessionId: innerSessionId,
      requestId,
      optionId,
    });
    if (paired.permissionRoutes.size === 0 && paired.stateBeforeApproval) {
      paired.state = paired.stateBeforeApproval.state;
      paired.activeRole = paired.stateBeforeApproval.activeRole;
      paired.stateBeforeApproval = null;
      emitPairedStatus(paired);
    }
  }

  return {
    hasSession(sessionId) {
      return pairedSessions.has(sessionId);
    },
    interceptEmit,
    spawnSession,
    sendPrompt,
    cancelPrompt,
    terminateSession,
    listSessions,
    setSessionModel,
    updateSessionConfigOption,
    setPermissionMode,
    respondToPermission,
  };
}
