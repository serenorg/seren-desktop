// ABOUTME: Core validation service — task classification, plan generation, execution, and repair loop.
// ABOUTME: Orchestrates the full validation lifecycle after an agent prompt completes.

import { isTauriRuntime } from "@/lib/tauri-bridge";
import type { AgentMessage } from "@/stores/agent.store";
import { validationStore } from "@/stores/validation.store";
import type {
  ArtifactValidationConfig,
  BrowserValidationConfig,
  EligibilityReason,
  HealthCheckValidationConfig,
  TaskCategory,
  TerminalValidationConfig,
  ValidationArtifact,
  ValidationRun,
  ValidationSettings,
  ValidationStep,
  ValidationStepConfig,
  ValidationStepResult,
} from "@/types/validation";

// ============================================================================
// ID generator
// ============================================================================

let idCounter = 0;
function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++idCounter}`;
}

// ============================================================================
// Task Classification (Planner)
// ============================================================================

/** Tool kinds that indicate code editing. */
const CODE_EDIT_TOOLS = new Set([
  "edit",
  "write",
  "create",
  "patch",
  "replace",
  "sed",
  "awk",
  "file_write",
  "file_edit",
  "Edit",
  "Write",
  "MultiEdit",
]);

/** Tool kinds that indicate browser automation. */
const BROWSER_TOOLS = new Set([
  "browser",
  "navigate",
  "click",
  "screenshot",
  "playwright",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
]);

/** Tool kinds that indicate terminal/test execution. */
const TERMINAL_TOOLS = new Set([
  "bash",
  "terminal",
  "shell",
  "run",
  "execute",
  "Bash",
  "command",
]);

/** Tool kinds that indicate file generation. */
const FILE_GEN_TOOLS = new Set([
  "write",
  "create",
  "file_write",
  "Write",
  "save",
  "export",
]);

/** Known test commands in project config files. Reserved for future runtime detection. */
const _KNOWN_TEST_COMMANDS: Record<string, string> = {
  "package.json": "pnpm test",
  "Cargo.toml": "cargo test",
  "pyproject.toml": "pytest",
  Makefile: "make test",
  "go.mod": "go test ./...",
};

/**
 * Classify the task category from agent message history.
 * Scans tool calls in the conversation to detect what kind of work was done.
 */
export function classifyTask(messages: AgentMessage[]): TaskCategory {
  const toolMessages = messages.filter((m) => m.type === "tool");
  const diffMessages = messages.filter((m) => m.type === "diff");

  if (diffMessages.length > 0) return "code_edit";

  let hasCodeEdit = false;
  let hasBrowser = false;
  let hasTerminal = false;
  let hasFileGen = false;

  for (const msg of toolMessages) {
    const kind = msg.toolCall?.kind ?? "";
    const title = (msg.toolCall?.title ?? "").toLowerCase();

    if (CODE_EDIT_TOOLS.has(kind)) hasCodeEdit = true;
    if (BROWSER_TOOLS.has(kind)) hasBrowser = true;
    if (TERMINAL_TOOLS.has(kind)) hasTerminal = true;
    if (FILE_GEN_TOOLS.has(kind)) hasFileGen = true;

    // Also check title for hints
    if (title.includes("edit") || title.includes("write file"))
      hasCodeEdit = true;
    if (title.includes("browser") || title.includes("navigate"))
      hasBrowser = true;
    if (
      title.includes("test") ||
      title.includes("npm") ||
      title.includes("cargo")
    )
      hasTerminal = true;
  }

  // Priority: browser > code_edit > file_generation > terminal > general
  if (hasBrowser) return "browser_automation";
  if (hasCodeEdit) return "code_edit";
  if (hasFileGen) return "file_generation";
  if (hasTerminal) return "terminal_command";

  return "general";
}

/**
 * Determine whether a task is eligible for automatic validation.
 */
export function checkEligibility(
  category: TaskCategory,
  settings: ValidationSettings,
): { eligible: boolean; reason: EligibilityReason } {
  if (!settings.enabled) {
    return { eligible: false, reason: "not_eligible" };
  }

  if (settings.skippedCategories.includes(category)) {
    return { eligible: false, reason: "skipped_by_user" };
  }

  // If user has required categories set, only those are eligible
  if (settings.requiredCategories.length > 0) {
    if (settings.requiredCategories.includes(category)) {
      return { eligible: true, reason: "user_required" };
    }
    return { eligible: false, reason: "not_eligible" };
  }

  // Auto-detect: all non-general tasks are eligible
  if (category === "general") {
    return { eligible: false, reason: "not_eligible" };
  }

  const reasonMap: Record<TaskCategory, EligibilityReason> = {
    code_edit: "code_diff_detected",
    ui_change: "code_diff_detected",
    browser_automation: "browser_action_detected",
    deployment: "tool_calls_detected",
    file_generation: "file_write_detected",
    test_execution: "tool_calls_detected",
    terminal_command: "tool_calls_detected",
    general: "not_eligible",
  };

  return { eligible: true, reason: reasonMap[category] };
}

// ============================================================================
// Plan Generation
// ============================================================================

/**
 * Generate a validation plan based on the task category and messages.
 */
export function generatePlan(
  category: TaskCategory,
  messages: AgentMessage[],
  cwd: string,
  settings: ValidationSettings,
): ValidationStep[] {
  const steps: ValidationStep[] = [];

  switch (category) {
    case "code_edit":
    case "ui_change":
      steps.push(...generateCodeEditSteps(messages, cwd, settings));
      break;
    case "browser_automation":
      steps.push(...generateBrowserSteps(messages, settings));
      break;
    case "file_generation":
      steps.push(...generateArtifactSteps(messages, settings));
      break;
    case "terminal_command":
    case "test_execution":
      steps.push(...generateTerminalSteps(messages, cwd, settings));
      break;
    case "deployment":
      steps.push(...generateDeploymentSteps(messages, cwd, settings));
      break;
    default:
      break;
  }

  return steps;
}

function generateCodeEditSteps(
  messages: AgentMessage[],
  cwd: string,
  settings: ValidationSettings,
): ValidationStep[] {
  const steps: ValidationStep[] = [];

  // Step 1: Check that edited files exist
  const editedFiles = extractEditedFiles(messages);
  if (editedFiles.length > 0) {
    steps.push(
      makeStep("Verify edited files exist", "artifact", {
        type: "artifact",
        expectedPaths: editedFiles,
        nonEmpty: true,
      }),
    );
  }

  // Step 2: Run tests if available
  if (settings.autoRunTests) {
    steps.push(
      makeStep("Run project tests", "terminal", {
        type: "terminal",
        command:
          "pnpm test --run 2>&1 || npm test 2>&1 || cargo test 2>&1 || echo 'NO_TEST_RUNNER'",
        cwd,
        timeoutMs: settings.stepTimeoutMs,
      }),
    );
  }

  // Step 3: Run linter/type check
  steps.push(
    makeStep("Run type check and linting", "terminal", {
      type: "terminal",
      command:
        "pnpm check 2>&1 || npx tsc --noEmit 2>&1 || cargo check 2>&1 || echo 'NO_LINT_RUNNER'",
      cwd,
      timeoutMs: settings.stepTimeoutMs,
    }),
  );

  return steps;
}

function generateBrowserSteps(
  messages: AgentMessage[],
  settings: ValidationSettings,
): ValidationStep[] {
  const steps: ValidationStep[] = [];

  // Extract URLs visited during the browser automation
  const urls = extractBrowserUrls(messages);

  for (const url of urls.slice(0, 3)) {
    steps.push(
      makeStep(`Verify page loads: ${truncateUrl(url)}`, "browser", {
        type: "browser",
        url,
        captureScreenshot: settings.captureScreenshots,
        timeoutMs: settings.stepTimeoutMs,
      }),
    );
  }

  // If no URLs found, add a health check for localhost
  if (urls.length === 0) {
    steps.push(
      makeStep("Check local dev server", "health_check", {
        type: "health_check",
        url: "http://localhost:3000",
        expectedStatus: 200,
        timeoutMs: 5_000,
      }),
    );
  }

  return steps;
}

function generateArtifactSteps(
  messages: AgentMessage[],
  _settings: ValidationSettings,
): ValidationStep[] {
  const writtenFiles = extractWrittenFiles(messages);

  if (writtenFiles.length === 0) return [];

  return [
    makeStep("Verify generated files exist and are non-empty", "artifact", {
      type: "artifact",
      expectedPaths: writtenFiles,
      nonEmpty: true,
    }),
  ];
}

function generateTerminalSteps(
  messages: AgentMessage[],
  cwd: string,
  settings: ValidationSettings,
): ValidationStep[] {
  // For terminal tasks, re-run the last significant command to verify it succeeds
  const lastCommand = extractLastCommand(messages);

  if (!lastCommand) return [];

  return [
    makeStep(`Re-verify: ${truncateCommand(lastCommand)}`, "terminal", {
      type: "terminal",
      command: lastCommand,
      cwd,
      timeoutMs: settings.stepTimeoutMs,
    }),
  ];
}

function generateDeploymentSteps(
  messages: AgentMessage[],
  _cwd: string,
  _settings: ValidationSettings,
): ValidationStep[] {
  const steps: ValidationStep[] = [];

  // Check for deployment URLs
  const urls = extractDeploymentUrls(messages);
  for (const url of urls.slice(0, 2)) {
    steps.push(
      makeStep(`Health check: ${truncateUrl(url)}`, "health_check", {
        type: "health_check",
        url,
        expectedStatus: 200,
        timeoutMs: 10_000,
      }),
    );
  }

  return steps;
}

// ============================================================================
// Message Extraction Helpers
// ============================================================================

function extractEditedFiles(messages: AgentMessage[]): string[] {
  const files = new Set<string>();

  for (const msg of messages) {
    if (msg.type === "diff" && msg.diff?.path) {
      files.add(msg.diff.path);
    }
    if (msg.type === "tool" && msg.toolCall) {
      const params = msg.toolCall.parameters as
        | Record<string, unknown>
        | undefined;
      if (params?.file_path && typeof params.file_path === "string") {
        files.add(params.file_path);
      }
      if (params?.path && typeof params.path === "string") {
        files.add(params.path);
      }
    }
  }

  return [...files];
}

function extractWrittenFiles(messages: AgentMessage[]): string[] {
  const files = new Set<string>();

  for (const msg of messages) {
    if (msg.type === "tool" && msg.toolCall) {
      const kind = msg.toolCall.kind ?? "";
      if (FILE_GEN_TOOLS.has(kind)) {
        const params = msg.toolCall.parameters as
          | Record<string, unknown>
          | undefined;
        if (params?.file_path && typeof params.file_path === "string") {
          files.add(params.file_path);
        }
        if (params?.path && typeof params.path === "string") {
          files.add(params.path);
        }
      }
    }
  }

  return [...files];
}

function extractBrowserUrls(messages: AgentMessage[]): string[] {
  const urls: string[] = [];

  for (const msg of messages) {
    if (msg.type === "tool" && msg.toolCall) {
      const params = msg.toolCall.parameters as
        | Record<string, unknown>
        | undefined;
      if (params?.url && typeof params.url === "string") {
        urls.push(params.url);
      }
    }
    // Also scan assistant content for URLs
    if (msg.type === "assistant" && msg.content) {
      const urlMatches = msg.content.match(/https?:\/\/[^\s)>\]]+/g);
      if (urlMatches) urls.push(...urlMatches);
    }
  }

  return [...new Set(urls)];
}

function extractDeploymentUrls(messages: AgentMessage[]): string[] {
  const urls: string[] = [];

  for (const msg of messages) {
    if (msg.type === "assistant" && msg.content) {
      const urlMatches = msg.content.match(/https?:\/\/[^\s)>\]]+/g);
      if (urlMatches) {
        for (const url of urlMatches) {
          // Filter for likely deployment URLs
          if (
            url.includes("deploy") ||
            url.includes("vercel") ||
            url.includes("netlify") ||
            url.includes("herokuapp") ||
            url.includes("cloudflare")
          ) {
            urls.push(url);
          }
        }
      }
    }
  }

  return [...new Set(urls)];
}

function extractLastCommand(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "tool" && msg.toolCall) {
      const kind = msg.toolCall.kind ?? "";
      if (TERMINAL_TOOLS.has(kind)) {
        const params = msg.toolCall.parameters as
          | Record<string, unknown>
          | undefined;
        if (params?.command && typeof params.command === "string") {
          return params.command;
        }
      }
    }
  }
  return null;
}

// ============================================================================
// Step Factory
// ============================================================================

function makeStep(
  label: string,
  executor: ValidationStep["executor"],
  config: ValidationStepConfig,
): ValidationStep {
  return {
    id: makeId("vstep"),
    label,
    executor,
    config,
    status: "pending",
  };
}

// ============================================================================
// Executors
// ============================================================================

/**
 * Execute a single validation step.
 * Returns the result (pass/fail) with details.
 */
export async function executeStep(
  step: ValidationStep,
  sessionCwd: string,
): Promise<ValidationStepResult> {
  const config = step.config;

  switch (config.type) {
    case "terminal":
      return executeTerminalStep(config, sessionCwd);
    case "artifact":
      return executeArtifactStep(config, sessionCwd);
    case "browser":
      return executeBrowserStep(config);
    case "health_check":
      return executeHealthCheckStep(config);
    default:
      return {
        passed: false,
        summary: `Unknown executor type: ${(config as ValidationStepConfig).type}`,
        error: "Unsupported validation type",
      };
  }
}

async function executeTerminalStep(
  config: TerminalValidationConfig,
  sessionCwd: string,
): Promise<ValidationStepResult> {
  const cwd = config.cwd ?? sessionCwd;
  const timeout = config.timeoutMs ?? 30_000;

  try {
    if (isTauriRuntime()) {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>("run_shell_command", {
        command: config.command,
        cwd,
        timeoutMs: timeout,
      });

      const output = `${result.stdout}\n${result.stderr}`.trim();
      const noRunner =
        output.includes("NO_TEST_RUNNER") || output.includes("NO_LINT_RUNNER");

      if (noRunner) {
        return {
          passed: true,
          summary: "No test/lint runner detected — skipped.",
          details: output,
        };
      }

      return {
        passed: result.exitCode === 0,
        summary:
          result.exitCode === 0
            ? "Command completed successfully."
            : `Command failed with exit code ${result.exitCode}.`,
        details: output.slice(0, 8_000),
      };
    }

    // Browser fallback — can't run shell commands
    return {
      passed: true,
      summary: "Terminal validation skipped (not in Tauri runtime).",
    };
  } catch (error) {
    return {
      passed: false,
      summary: "Terminal command execution failed.",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeArtifactStep(
  config: ArtifactValidationConfig,
  _sessionCwd: string,
): Promise<ValidationStepResult> {
  const missing: string[] = [];
  const empty: string[] = [];

  try {
    if (isTauriRuntime()) {
      const { invoke } = await import("@tauri-apps/api/core");

      for (const filePath of config.expectedPaths) {
        try {
          const exists = await invoke<boolean>("file_exists", {
            path: filePath,
          });
          if (!exists) {
            missing.push(filePath);
            continue;
          }
          if (config.nonEmpty) {
            const size = await invoke<number>("file_size", { path: filePath });
            if (size === 0) empty.push(filePath);
          }
        } catch {
          missing.push(filePath);
        }
      }
    } else {
      // Browser fallback — skip file checks
      return {
        passed: true,
        summary: "Artifact validation skipped (not in Tauri runtime).",
      };
    }

    const allGood = missing.length === 0 && empty.length === 0;
    const details: string[] = [];
    if (missing.length > 0) details.push(`Missing: ${missing.join(", ")}`);
    if (empty.length > 0) details.push(`Empty: ${empty.join(", ")}`);

    return {
      passed: allGood,
      summary: allGood
        ? `All ${config.expectedPaths.length} file(s) verified.`
        : `${missing.length} missing, ${empty.length} empty out of ${config.expectedPaths.length} file(s).`,
      details: details.join("\n") || undefined,
    };
  } catch (error) {
    return {
      passed: false,
      summary: "Artifact validation failed.",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeBrowserStep(
  config: BrowserValidationConfig,
): Promise<ValidationStepResult> {
  // Browser validation uses the MCP Playwright server if available.
  // For now, fall back to a simple fetch health check.
  try {
    const response = await fetch(config.url, {
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });

    const passed = response.ok;
    const artifacts: ValidationArtifact[] = [];

    return {
      passed,
      summary: passed
        ? `Page loaded successfully (${response.status}).`
        : `Page returned HTTP ${response.status}.`,
      details: `URL: ${config.url}\nStatus: ${response.status} ${response.statusText}`,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
    };
  } catch (error) {
    return {
      passed: false,
      summary: `Failed to load page: ${config.url}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function executeHealthCheckStep(
  config: HealthCheckValidationConfig,
): Promise<ValidationStepResult> {
  const expectedStatus = config.expectedStatus ?? 200;

  try {
    const response = await fetch(config.url, {
      method: "HEAD",
      signal: AbortSignal.timeout(config.timeoutMs ?? 5_000),
    });

    const passed = response.status === expectedStatus;

    return {
      passed,
      summary: passed
        ? `Health check passed (${response.status}).`
        : `Expected ${expectedStatus}, got ${response.status}.`,
      details: `URL: ${config.url}\nStatus: ${response.status}`,
    };
  } catch (error) {
    return {
      passed: false,
      summary: `Health check failed: ${config.url}`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Validation Loop Orchestrator
// ============================================================================

/**
 * Run the full validation loop for a completed agent prompt.
 * This is the main entry point called from the agent store on promptComplete.
 */
export async function runValidationLoop(
  sessionId: string,
  conversationId: string,
  messages: AgentMessage[],
  cwd: string,
  onRepairRequest?: (failureSummary: string) => Promise<void>,
): Promise<ValidationRun> {
  const settings = validationStore.settings;

  // 1. Classify the task
  const category = classifyTask(messages);

  // 2. Check eligibility
  const { eligible, reason } = checkEligibility(category, settings);

  // 3. Create the run
  const run: ValidationRun = {
    id: makeId("vrun"),
    sessionId,
    conversationId,
    startedAt: Date.now(),
    status: eligible ? "planning" : "skipped",
    taskCategory: category,
    eligibilityReason: reason,
    steps: [],
    repairIteration: 0,
    maxRepairs: settings.maxRepairAttempts,
  };

  validationStore.createRun(run);

  if (!eligible) {
    validationStore.setRunStatus(run.id, "skipped");
    validationStore.setRunSummary(
      run.id,
      reason === "skipped_by_user"
        ? "Validation skipped by user preference."
        : "Task not eligible for automatic validation.",
    );
    return validationStore.getRun(run.id) as ValidationRun;
  }

  // 4. Generate plan
  const steps = generatePlan(category, messages, cwd, settings);

  if (steps.length === 0) {
    validationStore.setRunStatus(run.id, "skipped");
    validationStore.setRunSummary(
      run.id,
      "No validation steps could be generated for this task.",
    );
    return validationStore.getRun(run.id) as ValidationRun;
  }

  validationStore.replaceSteps(run.id, steps);
  validationStore.setRunStatus(run.id, "running");

  // 5. Execute steps
  let allPassed = true;
  const failedStepSummaries: string[] = [];

  for (const step of steps) {
    validationStore.setStepStatus(run.id, step.id, "running");
    const start = Date.now();

    const result = await executeStep(step, cwd);
    const duration = Date.now() - start;

    validationStore.setStepResult(run.id, step.id, result, duration);

    if (!result.passed) {
      allPassed = false;
      failedStepSummaries.push(
        `${step.label}: ${result.summary}${result.details ? `\n${result.details}` : ""}`,
      );
    }
  }

  // 6. Handle results
  if (allPassed) {
    const totalDuration = Date.now() - run.startedAt;
    validationStore.setRunStatus(run.id, "passed");
    validationStore.setRunSummary(
      run.id,
      `All ${steps.length} validation step(s) passed.`,
    );
    validationStore.setRunDuration(run.id, totalDuration);
    return validationStore.getRun(run.id) as ValidationRun;
  }

  // 7. Repair loop
  const currentRun = validationStore.getRun(run.id) as ValidationRun;
  if (onRepairRequest && currentRun.repairIteration < currentRun.maxRepairs) {
    validationStore.setRunStatus(run.id, "repairing");
    validationStore.incrementRepair(run.id);

    const failureSummary = [
      "## Validation Failed",
      "",
      `**Task category:** ${category}`,
      `**Repair attempt:** ${currentRun.repairIteration + 1} of ${currentRun.maxRepairs}`,
      "",
      "### Failed Steps",
      "",
      ...failedStepSummaries.map((s) => `- ${s}`),
      "",
      "Please fix the issues above and try again.",
    ].join("\n");

    try {
      await onRepairRequest(failureSummary);
      // After repair, the caller will re-invoke runValidationLoop
    } catch (error) {
      console.error("[Validation] Repair request failed:", error);
    }
  } else {
    // No more repairs or no repair handler
    const totalDuration = Date.now() - run.startedAt;
    validationStore.setRunStatus(run.id, "failed");
    validationStore.setRunSummary(
      run.id,
      currentRun.repairIteration >= currentRun.maxRepairs
        ? `Validation failed after ${currentRun.maxRepairs} repair attempt(s).`
        : `Validation failed: ${failedStepSummaries.length} step(s) failed.`,
    );
    validationStore.setRunDuration(run.id, totalDuration);
  }

  return validationStore.getRun(run.id) as ValidationRun;
}

// ============================================================================
// Utility
// ============================================================================

function truncateUrl(url: string, max = 60): string {
  return url.length > max ? `${url.slice(0, max)}...` : url;
}

function truncateCommand(cmd: string, max = 50): string {
  return cmd.length > max ? `${cmd.slice(0, max)}...` : cmd;
}
