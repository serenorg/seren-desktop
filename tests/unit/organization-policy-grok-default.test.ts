// ABOUTME: Guards the allow_grok_agent default against reopening a closed org (#3154).
// ABOUTME: A field an admin never had cannot be read as consent to a new agent.

import { describe, expect, it } from "vitest";
import {
  allowsGrokAgent,
  type OrganizationPrivateModelsPolicy,
} from "@/services/organization-policy";

function policy(
  overrides: Partial<OrganizationPrivateModelsPolicy>,
): OrganizationPrivateModelsPolicy {
  return {
    organization_id: "org_test",
    mode: "standard",
    data_handling_attestation: {
      status: "unknown",
      scope: "organization_private_model_inference",
      training_use: "unknown",
      prompt_retention: "unknown",
      output_retention: "unknown",
      derived_data_retention: "unknown",
    },
    deployment_id: null,
    disable_seren_models: false,
    disable_local_agents: false,
    disable_external_model_providers: false,
    hide_model_picker: false,
    session_database: null,
    private_output_policy: "control_plane",
    updated_at: "2026-07-21T00:00:00Z",
    ...overrides,
  };
}

describe("allowsGrokAgent (#3154)", () => {
  it("stays open for orgs that never restricted local agents", () => {
    expect(allowsGrokAgent(null)).toBe(true);
    expect(allowsGrokAgent(undefined)).toBe(true);
    expect(allowsGrokAgent(policy({}))).toBe(true);
  });

  it("honors an explicit allow_grok_agent in both directions", () => {
    expect(allowsGrokAgent(policy({ allow_grok_agent: true }))).toBe(true);
    expect(allowsGrokAgent(policy({ allow_grok_agent: false }))).toBe(false);
  });

  it("keeps an explicit opt-in above the inferred lockdown", () => {
    // An admin who names Grok has answered for it; the inference below only
    // fills in for the field they never had.
    expect(
      allowsGrokAgent(
        policy({
          allow_grok_agent: true,
          allow_claude_agent: false,
          allow_codex_agent: false,
          allow_gemini_agent: false,
          allow_lmstudio_agent: false,
        }),
      ),
    ).toBe(true);
  });

  it("does not appear on upgrade for an org that closed every prior local agent", () => {
    // The upgrade path from #3154: on v3.71.0 this org saw zero local coding
    // agents. Defaulting the new field to true handed them a Grok launcher
    // with workspace write access, and allow_grok_agent did not exist yet so
    // there was no way to pre-set it.
    expect(
      allowsGrokAgent(
        policy({
          allow_claude_agent: false,
          allow_codex_agent: false,
          allow_gemini_agent: false,
          allow_lmstudio_agent: false,
        }),
      ),
    ).toBe(false);
  });

  it("honors disable_local_agents the way LM Studio does", () => {
    expect(allowsGrokAgent(policy({ disable_local_agents: true }))).toBe(false);
  });

  it("stays open when the org left any prior local agent enabled", () => {
    // A partial restriction is a choice about those agents, not a lockdown.
    expect(
      allowsGrokAgent(
        policy({
          allow_claude_agent: false,
          allow_codex_agent: false,
          allow_gemini_agent: false,
        }),
      ),
    ).toBe(true);
    expect(
      allowsGrokAgent(
        policy({
          allow_claude_agent: false,
          allow_codex_agent: false,
          allow_gemini_agent: false,
          allow_lmstudio_agent: true,
        }),
      ),
    ).toBe(true);
  });
});
