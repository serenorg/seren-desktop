// ABOUTME: Type definitions for the agent self-testing and validation loop.
// ABOUTME: Covers validation plans, executors, results, artifacts, and settings.

// ============================================================================
// Task Classification
// ============================================================================

/** Categories of tasks that may be eligible for automatic validation. */
export type TaskCategory =
  | "code_edit"
  | "ui_change"
  | "browser_automation"
  | "deployment"
  | "file_generation"
  | "test_execution"
  | "terminal_command"
  | "general";

/** How validation eligibility was determined. */
export type EligibilityReason =
  | "tool_calls_detected"
  | "code_diff_detected"
  | "browser_action_detected"
  | "file_write_detected"
  | "user_required"
  | "skipped_by_user"
  | "not_eligible";

// ============================================================================
// Validation Plan
// ============================================================================

/** A single step in a validation plan. */
export interface ValidationStep {
  id: string;
  /** Human-readable description of what this step validates. */
  label: string;
  /** Which executor runs this step. */
  executor: ValidatorType;
  /** Executor-specific configuration. */
  config: ValidationStepConfig;
  /** Current execution status. */
  status: ValidationStepStatus;
  /** Result after execution, if complete. */
  result?: ValidationStepResult;
  /** Duration in ms, set after execution. */
  durationMs?: number;
}

export type ValidationStepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "error";

/** Executor-specific config for a validation step. */
export type ValidationStepConfig =
  | TerminalValidationConfig
  | ArtifactValidationConfig
  | BrowserValidationConfig
  | HealthCheckValidationConfig;

export interface TerminalValidationConfig {
  type: "terminal";
  /** Shell command to run (e.g., "pnpm test", "cargo check"). */
  command: string;
  /** Working directory (defaults to session cwd). */
  cwd?: string;
  /** Timeout in ms. */
  timeoutMs?: number;
}

export interface ArtifactValidationConfig {
  type: "artifact";
  /** File paths to check for existence. */
  expectedPaths: string[];
  /** Optional: check file is non-empty. */
  nonEmpty?: boolean;
  /** Optional: match content pattern (regex string). */
  contentPattern?: string;
}

export interface BrowserValidationConfig {
  type: "browser";
  /** URL to navigate to. */
  url: string;
  /** DOM selector assertions. */
  assertions?: BrowserAssertion[];
  /** Take screenshot after check. */
  captureScreenshot?: boolean;
  /** Timeout in ms for page load. */
  timeoutMs?: number;
}

export interface HealthCheckValidationConfig {
  type: "health_check";
  /** URL to probe. */
  url: string;
  /** Expected HTTP status (defaults to 200). */
  expectedStatus?: number;
  /** Timeout in ms. */
  timeoutMs?: number;
}

export interface BrowserAssertion {
  /** CSS selector to find. */
  selector: string;
  /** Expected text content (substring match). */
  textContains?: string;
  /** Element should be visible. */
  visible?: boolean;
}

// ============================================================================
// Validation Results
// ============================================================================

/** Result of a single validation step. */
export interface ValidationStepResult {
  passed: boolean;
  /** Human-readable summary of what happened. */
  summary: string;
  /** Detailed output (command stdout, assertion details, etc.). */
  details?: string;
  /** Artifacts produced (screenshots, logs). */
  artifacts?: ValidationArtifact[];
  /** Error message if the executor itself failed. */
  error?: string;
}

export interface ValidationArtifact {
  id: string;
  /** Display label. */
  label: string;
  type: "screenshot" | "log" | "trace" | "file";
  /** Base64 data or file path. */
  data: string;
  /** MIME type for rendering. */
  mimeType?: string;
  /** Timestamp when captured. */
  capturedAt: number;
}

// ============================================================================
// Validation Run (top-level)
// ============================================================================

export type ValidationRunStatus =
  | "planning"
  | "running"
  | "passed"
  | "failed"
  | "repairing"
  | "skipped"
  | "error";

/** A complete validation run for a single agent prompt completion. */
export interface ValidationRun {
  id: string;
  /** Session this validation belongs to. */
  sessionId: string;
  /** Conversation this validation belongs to. */
  conversationId: string;
  /** Timestamp when validation started. */
  startedAt: number;
  /** Timestamp when validation completed. */
  completedAt?: number;
  /** Overall status. */
  status: ValidationRunStatus;
  /** Detected task category. */
  taskCategory: TaskCategory;
  /** How eligibility was determined. */
  eligibilityReason: EligibilityReason;
  /** The validation plan. */
  steps: ValidationStep[];
  /** Current repair iteration (0 = first attempt, 1+ = repair attempts). */
  repairIteration: number;
  /** Max repair attempts allowed. */
  maxRepairs: number;
  /** Summary of the overall result. */
  summary?: string;
  /** Duration in ms for the entire run. */
  durationMs?: number;
}

// ============================================================================
// Validator Types
// ============================================================================

export type ValidatorType =
  | "terminal"
  | "artifact"
  | "browser"
  | "health_check";

// ============================================================================
// Settings
// ============================================================================

/** User-configurable validation preferences. */
export interface ValidationSettings {
  /** Master enable/disable. */
  enabled: boolean;
  /** Max repair iterations before giving up. */
  maxRepairAttempts: number;
  /** Task categories that require validation. Empty = auto-detect. */
  requiredCategories: TaskCategory[];
  /** Task categories to never validate. */
  skippedCategories: TaskCategory[];
  /** Whether to auto-run terminal tests when repo has a test command. */
  autoRunTests: boolean;
  /** Whether to capture browser screenshots during validation. */
  captureScreenshots: boolean;
  /** Global timeout per validation step (ms). */
  stepTimeoutMs: number;
}

export const DEFAULT_VALIDATION_SETTINGS: ValidationSettings = {
  enabled: true,
  maxRepairAttempts: 2,
  requiredCategories: [],
  skippedCategories: [],
  autoRunTests: true,
  captureScreenshots: true,
  stepTimeoutMs: 30_000,
};
