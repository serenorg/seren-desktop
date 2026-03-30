// ABOUTME: Reactive store for tracking validation runs, results, and settings.
// ABOUTME: Persists validation settings and provides actions for the validation lifecycle.

import { createStore, produce } from "solid-js/store";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import {
  DEFAULT_VALIDATION_SETTINGS,
  type ValidationArtifact,
  type ValidationRun,
  type ValidationRunStatus,
  type ValidationSettings,
  type ValidationStep,
  type ValidationStepResult,
  type ValidationStepStatus,
} from "@/types/validation";

const SETTINGS_STORE = "settings.json";
const VALIDATION_SETTINGS_KEY = "validation";
const BROWSER_VALIDATION_KEY = "seren_validation_settings";

// ============================================================================
// State
// ============================================================================

interface ValidationState {
  /** All validation runs keyed by run ID. */
  runs: Record<string, ValidationRun>;
  /** Map from sessionId → most recent run ID for quick lookup. */
  activeRunBySession: Record<string, string>;
  /** User preferences. */
  settings: ValidationSettings;
  /** Whether settings have been loaded from storage. */
  settingsLoaded: boolean;
}

const [state, setState] = createStore<ValidationState>({
  runs: {},
  activeRunBySession: {},
  settings: { ...DEFAULT_VALIDATION_SETTINGS },
  settingsLoaded: false,
});

// ============================================================================
// Settings Persistence
// ============================================================================

async function getInvoke(): Promise<
  typeof import("@tauri-apps/api/core").invoke | null
> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

async function loadValidationSettings(): Promise<void> {
  try {
    const invoke = await getInvoke();
    let stored: string | null = null;

    if (invoke) {
      stored = await invoke<string | null>("get_setting", {
        store: SETTINGS_STORE,
        key: VALIDATION_SETTINGS_KEY,
      });
    } else {
      stored = localStorage.getItem(BROWSER_VALIDATION_KEY);
    }

    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ValidationSettings>;
      setState("settings", { ...DEFAULT_VALIDATION_SETTINGS, ...parsed });
    }
  } catch {
    // Use defaults on error
  }
  setState("settingsLoaded", true);
}

async function saveValidationSettings(): Promise<void> {
  try {
    const invoke = await getInvoke();
    const value = JSON.stringify(state.settings);

    if (invoke) {
      await invoke("set_setting", {
        store: SETTINGS_STORE,
        key: VALIDATION_SETTINGS_KEY,
        value,
      });
    } else {
      localStorage.setItem(BROWSER_VALIDATION_KEY, value);
    }
  } catch (error) {
    console.error("[ValidationStore] Failed to save settings:", error);
  }
}

// ============================================================================
// Public Store
// ============================================================================

export const validationStore = {
  /** Reactive access to all state. */
  get state() {
    return state;
  },

  /** Get validation settings. */
  get settings(): ValidationSettings {
    return state.settings;
  },

  /** Update a single setting. */
  setSetting<K extends keyof ValidationSettings>(
    key: K,
    value: ValidationSettings[K],
  ): void {
    setState("settings", key, value);
    saveValidationSettings();
  },

  /** Update multiple settings at once. */
  updateSettings(updates: Partial<ValidationSettings>): void {
    setState("settings", (prev) => ({ ...prev, ...updates }));
    saveValidationSettings();
  },

  /** Reset settings to defaults. */
  resetSettings(): void {
    setState("settings", { ...DEFAULT_VALIDATION_SETTINGS });
    saveValidationSettings();
  },

  /** Get the active validation run for a session. */
  getActiveRun(sessionId: string): ValidationRun | undefined {
    const runId = state.activeRunBySession[sessionId];
    return runId ? state.runs[runId] : undefined;
  },

  /** Get a specific run by ID. */
  getRun(runId: string): ValidationRun | undefined {
    return state.runs[runId];
  },

  /** Get all runs for a conversation. */
  getRunsForConversation(conversationId: string): ValidationRun[] {
    return Object.values(state.runs).filter(
      (r) => r.conversationId === conversationId,
    );
  },

  // --------------------------------------------------------------------------
  // Lifecycle actions
  // --------------------------------------------------------------------------

  /** Create a new validation run and set it as active for the session. */
  createRun(run: ValidationRun): void {
    setState("runs", run.id, run);
    setState("activeRunBySession", run.sessionId, run.id);
  },

  /** Update a run's top-level status. */
  setRunStatus(runId: string, status: ValidationRunStatus): void {
    setState("runs", runId, "status", status);
    if (
      status === "passed" ||
      status === "failed" ||
      status === "skipped" ||
      status === "error"
    ) {
      setState("runs", runId, "completedAt", Date.now());
    }
  },

  /** Set the run summary text. */
  setRunSummary(runId: string, summary: string): void {
    setState("runs", runId, "summary", summary);
  },

  /** Set the entire duration for a run. */
  setRunDuration(runId: string, durationMs: number): void {
    setState("runs", runId, "durationMs", durationMs);
  },

  /** Increment the repair iteration counter. */
  incrementRepair(runId: string): void {
    setState(
      "runs",
      runId,
      "repairIteration",
      (state.runs[runId]?.repairIteration ?? 0) + 1,
    );
  },

  // --------------------------------------------------------------------------
  // Step actions
  // --------------------------------------------------------------------------

  /** Update a step's status. */
  setStepStatus(
    runId: string,
    stepId: string,
    status: ValidationStepStatus,
  ): void {
    setState(
      "runs",
      runId,
      produce((run: ValidationRun) => {
        const step = run.steps.find((s) => s.id === stepId);
        if (step) step.status = status;
      }),
    );
  },

  /** Set a step's result. */
  setStepResult(
    runId: string,
    stepId: string,
    result: ValidationStepResult,
    durationMs: number,
  ): void {
    setState(
      "runs",
      runId,
      produce((run: ValidationRun) => {
        const step = run.steps.find((s) => s.id === stepId);
        if (step) {
          step.result = result;
          step.durationMs = durationMs;
          step.status = result.passed ? "passed" : "failed";
        }
      }),
    );
  },

  /** Append an artifact to a step's result. */
  addStepArtifact(
    runId: string,
    stepId: string,
    artifact: ValidationArtifact,
  ): void {
    setState(
      "runs",
      runId,
      produce((run: ValidationRun) => {
        const step = run.steps.find((s) => s.id === stepId);
        if (step?.result) {
          step.result.artifacts = [...(step.result.artifacts ?? []), artifact];
        }
      }),
    );
  },

  /** Replace all steps (used when replanning after repair). */
  replaceSteps(runId: string, steps: ValidationStep[]): void {
    setState("runs", runId, "steps", steps);
  },

  /** Remove a run (cleanup). */
  removeRun(runId: string): void {
    const run = state.runs[runId];
    if (run && state.activeRunBySession[run.sessionId] === runId) {
      setState("activeRunBySession", run.sessionId, undefined as never);
    }
    setState(
      "runs",
      produce((runs: Record<string, ValidationRun>) => {
        delete runs[runId];
      }),
    );
  },

  /** Load settings from storage on startup. */
  async init(): Promise<void> {
    await loadValidationSettings();
  },
};

// Eagerly load settings
loadValidationSettings();
