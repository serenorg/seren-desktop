// ABOUTME: Tests the eval-gate service: cron validation and SDK call shape for update/clear.
// ABOUTME: Mocks serenAgentUpdateManagedDeployment so we assert body shape, not network behaviour.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/api/seren-agent", () => ({
  serenAgentUpdateManagedDeployment: updateMock,
}));

import {
  clearEvalGate,
  updateEvalGate,
  validateCronExpression,
} from "@/services/eval-gate";

beforeEach(() => {
  updateMock.mockReset();
});

describe("validateCronExpression", () => {
  it("accepts a canonical 5-field cron", () => {
    expect(validateCronExpression("0 * * * *")).toBeNull();
  });

  it("accepts complex fields with commas and ranges", () => {
    expect(validateCronExpression("*/15 0,12 1-7 * 1")).toBeNull();
  });

  it("rejects fewer than 5 fields", () => {
    expect(validateCronExpression("0 * * *")).toMatch(/exactly 5 fields/);
  });

  it("rejects more than 5 fields", () => {
    expect(validateCronExpression("0 * * * * *")).toMatch(/exactly 5 fields/);
  });

  it("rejects empty input", () => {
    expect(validateCronExpression("   ")).toMatch(/required/);
  });
});

describe("updateEvalGate", () => {
  it("sends eval_gate body without schedule when not supplied", async () => {
    updateMock.mockResolvedValueOnce({ data: { data: {} }, error: undefined });

    await updateEvalGate("dep_1", {
      set_id: "set-a",
      max_age_seconds: 3600,
      block_on_failure: true,
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const args = updateMock.mock.calls[0][0];
    expect(args.path).toEqual({ id: "dep_1" });
    expect(args.body).toEqual({
      eval_gate: {
        set_id: "set-a",
        max_age_seconds: 3600,
        block_on_failure: true,
      },
    });
    expect(args.throwOnError).toBe(false);
  });

  it("includes schedule when supplied", async () => {
    updateMock.mockResolvedValueOnce({ data: { data: {} }, error: undefined });

    await updateEvalGate("dep_2", {
      set_id: "set-b",
      max_age_seconds: 7200,
      schedule: { cron: "0 6 * * *", timezone: "UTC" },
    });

    const args = updateMock.mock.calls[0][0];
    expect(args.body.eval_gate.schedule).toEqual({
      cron: "0 6 * * *",
      timezone: "UTC",
    });
  });

  it("surfaces backend errors", async () => {
    updateMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "invalid cron" },
      response: { status: 400 } as Response,
    });

    await expect(
      updateEvalGate("dep_3", { set_id: "x", max_age_seconds: 60 }),
    ).rejects.toThrow(/Failed to update eval gate: invalid cron/);
  });
});

describe("clearEvalGate", () => {
  it("sends clear_eval_gate=true", async () => {
    updateMock.mockResolvedValueOnce({ data: { data: {} }, error: undefined });

    await clearEvalGate("dep_clr");

    const args = updateMock.mock.calls[0][0];
    expect(args.path).toEqual({ id: "dep_clr" });
    expect(args.body).toEqual({ clear_eval_gate: true });
  });

  it("surfaces backend errors", async () => {
    updateMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "conflict" },
      response: { status: 409 } as Response,
    });

    await expect(clearEvalGate("dep_clr")).rejects.toThrow(
      /Failed to clear eval gate: conflict/,
    );
  });
});
