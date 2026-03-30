// ABOUTME: Unit tests for the validation service — task classification, eligibility, and plan generation.
// ABOUTME: Covers core business logic of the self-testing validation loop.

import { describe, it, expect } from "vitest";
import {
  classifyTask,
  checkEligibility,
  generatePlan,
} from "@/services/validation";
import type { AgentMessage } from "@/stores/agent.store";
import type { ValidationSettings, TaskCategory } from "@/types/validation";
import { DEFAULT_VALIDATION_SETTINGS } from "@/types/validation";

// ============================================================================
// Helpers
// ============================================================================

function makeMsg(
  overrides: Partial<AgentMessage> & { type: AgentMessage["type"] },
): AgentMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeToolMsg(kind: string, title = "", params?: Record<string, unknown>): AgentMessage {
  return makeMsg({
    type: "tool",
    toolCall: {
      sessionId: "s1",
      toolCallId: `tc_${Math.random().toString(36).slice(2)}`,
      title,
      kind,
      status: "completed",
      parameters: params,
    },
  });
}

function makeDiffMsg(path: string): AgentMessage {
  return makeMsg({
    type: "diff",
    diff: {
      sessionId: "s1",
      toolCallId: "tc1",
      path,
      oldText: "old",
      newText: "new",
    },
  });
}

const defaultSettings: ValidationSettings = { ...DEFAULT_VALIDATION_SETTINGS };

// ============================================================================
// classifyTask
// ============================================================================

describe("classifyTask", () => {
  it("classifies code edits from diff messages", () => {
    const messages = [
      makeMsg({ type: "user", content: "Fix the bug" }),
      makeDiffMsg("/src/app.ts"),
      makeMsg({ type: "assistant", content: "Fixed" }),
    ];
    expect(classifyTask(messages)).toBe("code_edit");
  });

  it("classifies code edits from edit tool calls", () => {
    const messages = [
      makeMsg({ type: "user", content: "Edit the file" }),
      makeToolMsg("Edit", "Edit file", { file_path: "/src/app.ts" }),
    ];
    expect(classifyTask(messages)).toBe("code_edit");
  });

  it("classifies browser automation from browser tool calls", () => {
    const messages = [
      makeMsg({ type: "user", content: "Navigate to site" }),
      makeToolMsg("browser_navigate", "Navigate to URL", { url: "https://example.com" }),
    ];
    expect(classifyTask(messages)).toBe("browser_automation");
  });

  it("classifies file generation from write tool calls", () => {
    const messages = [
      makeMsg({ type: "user", content: "Create a report" }),
      makeToolMsg("Write", "Write file", { file_path: "/output/report.txt" }),
    ];
    // Write is in both CODE_EDIT_TOOLS and FILE_GEN_TOOLS, but code_edit takes priority
    expect(classifyTask(messages)).toBe("code_edit");
  });

  it("classifies terminal commands from bash tool calls", () => {
    const messages = [
      makeMsg({ type: "user", content: "Run the build" }),
      makeToolMsg("Bash", "Run command", { command: "npm run build" }),
    ];
    expect(classifyTask(messages)).toBe("terminal_command");
  });

  it("returns general for messages with no tool calls", () => {
    const messages = [
      makeMsg({ type: "user", content: "What is the weather?" }),
      makeMsg({ type: "assistant", content: "I can't check the weather." }),
    ];
    expect(classifyTask(messages)).toBe("general");
  });

  it("prioritizes browser over code_edit when both present", () => {
    const messages = [
      makeToolMsg("Edit", "Edit file"),
      makeToolMsg("browser_navigate", "Navigate"),
    ];
    expect(classifyTask(messages)).toBe("browser_automation");
  });
});

// ============================================================================
// checkEligibility
// ============================================================================

describe("checkEligibility", () => {
  it("returns eligible for code_edit tasks with default settings", () => {
    const result = checkEligibility("code_edit", defaultSettings);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("code_diff_detected");
  });

  it("returns not eligible for general tasks", () => {
    const result = checkEligibility("general", defaultSettings);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("not_eligible");
  });

  it("returns not eligible when validation is disabled", () => {
    const result = checkEligibility("code_edit", {
      ...defaultSettings,
      enabled: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("not_eligible");
  });

  it("respects skippedCategories", () => {
    const result = checkEligibility("code_edit", {
      ...defaultSettings,
      skippedCategories: ["code_edit"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("skipped_by_user");
  });

  it("respects requiredCategories — only validates listed categories", () => {
    const settings: ValidationSettings = {
      ...defaultSettings,
      requiredCategories: ["browser_automation"],
    };
    expect(checkEligibility("browser_automation", settings).eligible).toBe(true);
    expect(checkEligibility("browser_automation", settings).reason).toBe("user_required");
    expect(checkEligibility("code_edit", settings).eligible).toBe(false);
  });

  it("returns eligible for browser_automation", () => {
    const result = checkEligibility("browser_automation", defaultSettings);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("browser_action_detected");
  });

  it("returns eligible for terminal_command", () => {
    const result = checkEligibility("terminal_command", defaultSettings);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("tool_calls_detected");
  });
});

// ============================================================================
// generatePlan
// ============================================================================

describe("generatePlan", () => {
  const cwd = "/home/user/project";

  it("generates artifact check + test + lint steps for code_edit", () => {
    const messages = [makeDiffMsg("/src/app.ts")];
    const steps = generatePlan("code_edit", messages, cwd, defaultSettings);

    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0].executor).toBe("artifact");
    expect(steps[0].label).toContain("Verify edited files exist");
    expect(steps.some((s) => s.executor === "terminal")).toBe(true);
  });

  it("skips test runner step when autoRunTests is disabled", () => {
    const messages = [makeDiffMsg("/src/app.ts")];
    const steps = generatePlan("code_edit", messages, cwd, {
      ...defaultSettings,
      autoRunTests: false,
    });

    // Should still have artifact check and lint, but not test runner
    const testStep = steps.find((s) => s.label.includes("Run project tests"));
    expect(testStep).toBeUndefined();
  });

  it("generates browser steps for browser_automation", () => {
    const messages = [
      makeToolMsg("browser_navigate", "Navigate", { url: "https://example.com" }),
    ];
    const steps = generatePlan("browser_automation", messages, cwd, defaultSettings);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps[0].executor).toBe("browser");
  });

  it("generates health check fallback when no browser URLs found", () => {
    const messages = [
      makeToolMsg("browser_click", "Click element"),
    ];
    const steps = generatePlan("browser_automation", messages, cwd, defaultSettings);

    expect(steps.some((s) => s.executor === "health_check")).toBe(true);
  });

  it("generates artifact steps for file_generation", () => {
    const messages = [
      makeToolMsg("Write", "Write file", { file_path: "/output/report.txt" }),
    ];
    const steps = generatePlan("file_generation", messages, cwd, defaultSettings);

    expect(steps.length).toBe(1);
    expect(steps[0].executor).toBe("artifact");
    expect(steps[0].config.type).toBe("artifact");
  });

  it("generates terminal re-verify for terminal_command", () => {
    const messages = [
      makeToolMsg("Bash", "Run npm build", { command: "npm run build" }),
    ];
    const steps = generatePlan("terminal_command", messages, cwd, defaultSettings);

    expect(steps.length).toBe(1);
    expect(steps[0].executor).toBe("terminal");
    expect(steps[0].label).toContain("Re-verify");
  });

  it("returns empty steps for general tasks", () => {
    const messages = [
      makeMsg({ type: "assistant", content: "Here's your answer." }),
    ];
    const steps = generatePlan("general", messages, cwd, defaultSettings);
    expect(steps).toHaveLength(0);
  });

  it("all steps start with pending status", () => {
    const messages = [makeDiffMsg("/src/app.ts")];
    const steps = generatePlan("code_edit", messages, cwd, defaultSettings);

    for (const step of steps) {
      expect(step.status).toBe("pending");
    }
  });

  it("each step has a unique ID", () => {
    const messages = [makeDiffMsg("/src/a.ts"), makeDiffMsg("/src/b.ts")];
    const steps = generatePlan("code_edit", messages, cwd, defaultSettings);

    const ids = steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
