// ABOUTME: Organization employee collaboration policy and assignment rules.
// ABOUTME: Shared by the desktop settings surface and the employees web app.

import type {
  CloudRunCollaborationSelection,
  OrganizationEmployeeCollaborationPolicy,
} from "@seren/employees-api-types";

export type OrganizationEmployeeCollaborationCapabilities = Pick<
  OrganizationEmployeeCollaborationPolicy,
  | "organization_knowledge_read"
  | "organization_credential_use"
  | "organization_skill_use"
  | "organization_artifact_write"
>;

export type OrganizationCollaborationSaveState = {
  policyEnabled: boolean;
  assigned: boolean;
  hasCurrentAssignment: boolean;
  otherAssignmentCount: number;
};

export type OrganizationCollaborationSaveActions = {
  upsertAssignment: () => Promise<void>;
  updatePolicy: () => Promise<void>;
  revokeAssignment: () => Promise<void>;
};

export function collaborationRunPayload(
  collaboration: CloudRunCollaborationSelection | undefined,
  extraPayload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const payload = { ...extraPayload };
  delete payload.collaboration;
  if (collaboration) payload.collaboration = collaboration;
  return Object.keys(payload).length > 0 ? payload : undefined;
}

export async function saveOrganizationCollaborationSettings(
  state: OrganizationCollaborationSaveState,
  actions: OrganizationCollaborationSaveActions,
): Promise<void> {
  if (
    state.policyEnabled &&
    !state.assigned &&
    state.otherAssignmentCount === 0
  ) {
    throw new Error(
      "Enable at least one employee assignment before enabling organization collaboration.",
    );
  }

  if (state.assigned) await actions.upsertAssignment();
  await actions.updatePolicy();
  if (!state.assigned && state.hasCurrentAssignment) {
    await actions.revokeAssignment();
  }
}
