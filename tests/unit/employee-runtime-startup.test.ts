// ABOUTME: Tests employee runtime startup retry behavior.
// ABOUTME: Keeps cold runtime starts from surfacing as immediate chat errors.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { serenCloudRun } from "@/api/seren-cloud";
import { runEmployeeMessage } from "@/services/employees-runtime";

vi.mock("@/api/seren-cloud", () => ({
  serenCloudDeploymentRun: vi.fn(),
  serenCloudDeploymentRunCancel: vi.fn(),
  serenCloudDeploymentRunStream: vi.fn(),
  serenCloudRun: vi.fn(),
}));

describe("runEmployeeMessage startup retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries while the employee runtime is still starting", async () => {
    vi.mocked(serenCloudRun)
      .mockResolvedValueOnce({
        data: undefined,
        error: {
          message: "Deployment is still starting. Try again in a moment.",
        },
        response: new Response(null, { status: 400 }),
      } as never)
      .mockResolvedValueOnce({
        data: {
          data: {
            result: { text: "Ready now." },
            run_id: null,
            status: "completed",
          },
        },
        error: undefined,
        response: new Response(null, { status: 200 }),
      } as never);
    const onStartupWait = vi.fn();

    const result = await runEmployeeMessage("dep_1", "hello", {
      onStartupWait,
      startupRetryDelayMs: 0,
      startupRetryTimeoutMs: 5_000,
    });

    expect(result.text).toBe("Ready now.");
    expect(serenCloudRun).toHaveBeenCalledTimes(2);
    expect(onStartupWait).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        message: "Deployment is still starting. Try again in a moment.",
      }),
    );
  });

  it("fails fast when the run trigger returns a non-startup error", async () => {
    vi.mocked(serenCloudRun).mockResolvedValueOnce({
      data: undefined,
      error: { message: "Bad request: missing message" },
      response: new Response(null, { status: 400 }),
    } as never);
    const onStartupWait = vi.fn();

    await expect(
      runEmployeeMessage("dep_1", "hello", {
        onStartupWait,
        startupRetryDelayMs: 0,
        startupRetryTimeoutMs: 5_000,
      }),
    ).rejects.toThrow("Failed to start employee run: Bad request");

    expect(serenCloudRun).toHaveBeenCalledTimes(1);
    expect(onStartupWait).not.toHaveBeenCalled();
  });

  it("does not retry the failed-deployment readiness error", async () => {
    vi.mocked(serenCloudRun).mockResolvedValueOnce({
      data: undefined,
      error: {
        message:
          "Deployment is not ready to accept requests. Check agent logs and restart it.",
      },
      response: new Response(null, { status: 400 }),
    } as never);
    const onStartupWait = vi.fn();

    await expect(
      runEmployeeMessage("dep_1", "hello", {
        onStartupWait,
        startupRetryDelayMs: 0,
        startupRetryTimeoutMs: 5_000,
      }),
    ).rejects.toThrow("Failed to start employee run: Deployment is not ready");

    expect(serenCloudRun).toHaveBeenCalledTimes(1);
    expect(onStartupWait).not.toHaveBeenCalled();
  });
});
