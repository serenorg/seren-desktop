// ABOUTME: Tests for OTP gating on private model access.
// ABOUTME: Covers policy check, session cache, resume flow, and failure states.

import { describe, expect, it } from "vitest";
import { requiresOtpStepUp } from "@/services/organization-policy";
import type { OrganizationPrivateModelsPolicy } from "@/services/organization-policy";
import { parseOtpDenial } from "@/services/otp";

function makePolicy(
  overrides?: Partial<OrganizationPrivateModelsPolicy>,
): OrganizationPrivateModelsPolicy {
  return {
    organization_id: "org-1",
    mode: "standard",
    deployment_id: null,
    force_private_model: false,
    disable_seren_models: false,
    disable_local_agents: false,
    disable_external_model_providers: false,
    hide_model_picker: false,
    session_database: null,
    private_output_policy: "control_plane",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ============================================================================
// Ticket #1460: OTP gate at selection and send boundaries
// ============================================================================

describe("requiresOtpStepUp", () => {
  it("non-private model is unaffected regardless of policy", () => {
    const policy = makePolicy({ otp_required_for_private_models: true });
    const result = requiresOtpStepUp(policy, false, () => "enroll");
    expect(result).toBeNull();
  });

  it("private model with OTP disabled is unaffected", () => {
    const policy = makePolicy({ otp_required_for_private_models: false });
    const result = requiresOtpStepUp(policy, true, () => "enroll");
    expect(result).toBeNull();
  });

  it("private model routes to enrollment when required + unenrolled", () => {
    const policy = makePolicy({ otp_required_for_private_models: true });
    const result = requiresOtpStepUp(policy, true, () => "enroll");
    expect(result).toBe("enroll");
  });

  it("private model routes to challenge when required + expired", () => {
    const policy = makePolicy({ otp_required_for_private_models: true });
    const result = requiresOtpStepUp(policy, true, () => "challenge");
    expect(result).toBe("challenge");
  });

  it("private model is allowed when verified", () => {
    const policy = makePolicy({ otp_required_for_private_models: true });
    const result = requiresOtpStepUp(policy, true, () => null);
    expect(result).toBeNull();
  });

  it("null policy is unaffected", () => {
    const result = requiresOtpStepUp(null, true, () => "enroll");
    expect(result).toBeNull();
  });
});

// ============================================================================
// Ticket #1461: OTP session cache and denial parsing
// ============================================================================

describe("parseOtpDenial", () => {
  it("detects not_enrolled denial", () => {
    expect(parseOtpDenial("user is not_enrolled for OTP")).toBe(
      "otp_not_enrolled",
    );
  });

  it("detects expired verification", () => {
    expect(parseOtpDenial("verification window expired")).toBe("otp_expired");
  });

  it("detects invalid code", () => {
    expect(parseOtpDenial("Invalid OTP code")).toBe("otp_invalid_code");
  });

  it("detects rate limit", () => {
    expect(parseOtpDenial("rate limit exceeded")).toBe("otp_rate_limited");
  });

  it("returns null for unrelated errors", () => {
    expect(parseOtpDenial("network timeout")).toBeNull();
  });
});

// ============================================================================
// Ticket #1462: Failure states and regression coverage
// ============================================================================

describe("OTP policy edge cases", () => {
  it("missing otp_required_for_private_models defaults to no gate", () => {
    const policy = makePolicy();
    // No otp_required_for_private_models field at all
    const result = requiresOtpStepUp(policy, true, () => "enroll");
    expect(result).toBeNull();
  });

  it("switching between private and non-private models works", () => {
    const policy = makePolicy({ otp_required_for_private_models: true });
    // Private model — gated
    expect(requiresOtpStepUp(policy, true, () => "challenge")).toBe(
      "challenge",
    );
    // Non-private — not gated
    expect(requiresOtpStepUp(policy, false, () => "challenge")).toBeNull();
    // Back to private — still gated
    expect(requiresOtpStepUp(policy, true, () => "challenge")).toBe(
      "challenge",
    );
  });

  it("non-private model works during OTP outage", () => {
    // Even if otpGate throws, non-private should work
    const policy = makePolicy({ otp_required_for_private_models: true });
    const result = requiresOtpStepUp(policy, false, () => {
      throw new Error("OTP service down");
    });
    expect(result).toBeNull();
  });
});
