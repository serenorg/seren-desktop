import {
  collaborationRunPayload,
  saveOrganizationCollaborationSettings,
} from "@seren/employees-core";
import { describe, expect, it, vi } from "vitest";

describe("collaborationRunPayload", () => {
  it("keeps individual execution as the implicit default", () => {
    expect(collaborationRunPayload(undefined)).toBeUndefined();
    expect(
      collaborationRunPayload(undefined, {
        collaboration: { invocation_origin: { kind: "direct" } },
        recording: { kind: "workflow_recording" },
      }),
    ).toEqual({ recording: { kind: "workflow_recording" } });
  });

  it("adds explicit organization context without dropping other payload", () => {
    const collaboration = {
      invocation_origin: { kind: "direct" as const },
      knowledge_selection: {
        kind: "organization" as const,
        provider: "memory" as const,
        selection_id: "selection-1",
      },
      knowledge_capture_target: { kind: "none" as const },
      task_label: "customer-support",
      output_audience: { kind: "organization" as const },
    };
    expect(
      collaborationRunPayload(
        collaboration,
        { recording: { kind: "workflow_recording" } },
      ),
    ).toEqual({
      collaboration,
      recording: { kind: "workflow_recording" },
    });
  });
});

describe("saveOrganizationCollaborationSettings", () => {
  it("persists the assignment before enabling the organization policy", async () => {
    const calls: string[] = [];
    await saveOrganizationCollaborationSettings(
      {
        policyEnabled: true,
        assigned: true,
        hasCurrentAssignment: false,
        otherAssignmentCount: 0,
      },
      {
        upsertAssignment: vi.fn(async () => {
          calls.push("assignment");
        }),
        updatePolicy: vi.fn(async () => {
          calls.push("policy");
        }),
        revokeAssignment: vi.fn(async () => {
          calls.push("revoke");
        }),
      },
    );

    expect(calls).toEqual(["assignment", "policy"]);
  });

  it("disables policy before revoking the last selected assignment", async () => {
    const calls: string[] = [];
    await saveOrganizationCollaborationSettings(
      {
        policyEnabled: false,
        assigned: false,
        hasCurrentAssignment: true,
        otherAssignmentCount: 0,
      },
      {
        upsertAssignment: vi.fn(async () => {
          calls.push("assignment");
        }),
        updatePolicy: vi.fn(async () => {
          calls.push("policy");
        }),
        revokeAssignment: vi.fn(async () => {
          calls.push("revoke");
        }),
      },
    );

    expect(calls).toEqual(["policy", "revoke"]);
  });

  it("rejects an enabled policy with no employee assignment before writing", async () => {
    const actions = {
      upsertAssignment: vi.fn(async () => undefined),
      updatePolicy: vi.fn(async () => undefined),
      revokeAssignment: vi.fn(async () => undefined),
    };

    await expect(
      saveOrganizationCollaborationSettings(
        {
          policyEnabled: true,
          assigned: false,
          hasCurrentAssignment: false,
          otherAssignmentCount: 0,
        },
        actions,
      ),
    ).rejects.toThrow("Enable at least one employee assignment");
    expect(actions.upsertAssignment).not.toHaveBeenCalled();
    expect(actions.updatePolicy).not.toHaveBeenCalled();
    expect(actions.revokeAssignment).not.toHaveBeenCalled();
  });
});
