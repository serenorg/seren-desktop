// ABOUTME: Tests the eval-drift service request/response shaping.
// ABOUTME: Guards the SDK client.get payload against accidental drift in path and headers.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDriftMock } = vi.hoisted(() => ({ getDriftMock: vi.fn() }));

vi.mock("@/api/seren-cloud", () => ({
  serenCloudGetDeploymentEvalDrift: getDriftMock,
}));

import { getEvalDrift } from "@/services/eval-drift";

const ORG = "00000000-0000-0000-0000-000000000010";
const DEP = "dep_abc";

beforeEach(() => {
  getDriftMock.mockReset();
});

describe("getEvalDrift", () => {
  it("issues GET against /deployments/{id}/eval-drift with org header", async () => {
    getDriftMock.mockResolvedValueOnce({
      data: { data: { message: "no baseline" } },
      error: undefined,
    });

    const out = await getEvalDrift(ORG, DEP);

    expect(getDriftMock).toHaveBeenCalledTimes(1);
    const args = getDriftMock.mock.calls[0][0];
    expect(args.path).toEqual({ id: DEP });
    expect(args.headers["x-organization-id"]).toBe(ORG);
    expect(args.throwOnError).toBe(false);
    expect(out).toEqual({ message: "no baseline" });
  });

  it("returns the typed envelope when present", async () => {
    getDriftMock.mockResolvedValueOnce({
      data: {
        data: {
          baseline: {
            baseline_run_id: "r1",
            baseline_set_id: "set-a",
            baseline_passed: 10,
            baseline_failed: 2,
            baseline_captured_at: "2026-01-01T00:00:00Z",
          },
          current_run_id: "r2",
          current_passed: 11,
          current_failed: 1,
          passed_delta: 1,
          failed_delta: -1,
          message: "drift",
        },
      },
      error: undefined,
    });

    const out = await getEvalDrift(ORG, DEP);
    expect(out.baseline?.baseline_passed).toBe(10);
    expect(out.passed_delta).toBe(1);
    expect(out.failed_delta).toBe(-1);
  });

  it("throws when the response succeeds but has no body envelope", async () => {
    getDriftMock.mockResolvedValueOnce({
      data: undefined,
      error: undefined,
    });

    await expect(getEvalDrift(ORG, DEP)).rejects.toThrow(
      /Eval drift response did not include a body/,
    );
  });

  it("maps 404 to an operator-safe message", async () => {
    getDriftMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "not found" },
      response: { status: 404 } as Response,
    });

    await expect(getEvalDrift(ORG, DEP)).rejects.toThrow(
      /Eval drift unavailable.*no eval gate attached/,
    );
  });

  it("maps 400 to an operator-safe bad-request message", async () => {
    getDriftMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "missing org" },
      response: { status: 400 } as Response,
    });

    await expect(getEvalDrift(ORG, DEP)).rejects.toThrow(
      /Eval drift unavailable: missing org/,
    );
  });

  it("surfaces other backend errors via formatApiError", async () => {
    getDriftMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "boom" },
      response: { status: 500 } as Response,
    });

    await expect(getEvalDrift(ORG, DEP)).rejects.toThrow(
      /Failed to load eval drift: boom/,
    );
  });
});
