import { describe, expect, it } from "vitest";
import {
  hasNoTrainingNoRetentionAttestation,
  type OrganizationPrivateModelsPolicy,
} from "@/services/organization-policy";

function policy(
  dataHandlingAttestation: OrganizationPrivateModelsPolicy["data_handling_attestation"],
): OrganizationPrivateModelsPolicy {
  return {
    organization_id: "00000000-0000-0000-0000-000000000001",
    mode: "private_org_agent",
    data_handling_attestation: dataHandlingAttestation,
    deployment_id: null,
    disable_seren_models: true,
    disable_local_agents: false,
    disable_external_model_providers: true,
    hide_model_picker: true,
    session_database: null,
    private_output_policy: "private_session_database",
    updated_at: "2026-07-23T00:00:00Z",
  };
}

describe("hasNoTrainingNoRetentionAttestation", () => {
  const affirmative = {
    status: "no_training_no_retention",
    scope: "organization_private_model_inference",
    training_use: "prohibited",
    prompt_retention: "none_after_response",
    output_retention: "none_after_response",
    derived_data_retention: "none_after_response",
    terms: "no_training_no_retention",
    basis: "policy_administrator",
    attested_at: "2026-07-23T00:00:00Z",
    attested_by_user_id: "00000000-0000-0000-0000-000000000002",
  } as const;

  it("accepts only the complete affirmative declaration", () => {
    expect(hasNoTrainingNoRetentionAttestation(policy(affirmative))).toBe(true);
  });

  it("denies absent and unknown declarations", () => {
    expect(hasNoTrainingNoRetentionAttestation(undefined)).toBe(false);
    expect(
      hasNoTrainingNoRetentionAttestation(
        policy({
          status: "unknown",
          scope: "organization_private_model_inference",
          training_use: "unknown",
          prompt_retention: "unknown",
          output_retention: "unknown",
          derived_data_retention: "unknown",
        }),
      ),
    ).toBe(false);
  });

  it("denies incomplete affirmative declarations", () => {
    expect(
      hasNoTrainingNoRetentionAttestation(
        policy({
          ...affirmative,
          derived_data_retention: "unknown",
        }),
      ),
    ).toBe(false);
  });
});
