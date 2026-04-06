// ABOUTME: OTP session state for private-model step-up verification.
// ABOUTME: Caches verification status and manages interrupted action resume.

import { createStore } from "solid-js/store";
import type { OtpEnrollmentStatus, OtpStatus } from "@/services/otp";
import { getOtpStatus } from "@/services/otp";

// ============================================================================
// Types
// ============================================================================

export type OtpGateAction = "send" | "model_select";

export interface InterruptedAction {
  type: OtpGateAction;
  /** The prompt text if interrupted during send. */
  prompt?: string;
  /** Timestamp to prevent stale resumes. */
  createdAt: number;
}

interface OtpState {
  /** Enrollment status from the backend. */
  enrollmentStatus: OtpEnrollmentStatus;
  /** Whether the org requires OTP for private models. */
  otpRequired: boolean;
  /** Epoch ms when current verification expires. Null = not verified. */
  verifiedUntil: number | null;
  /** Action interrupted by the OTP gate, to resume after verification. */
  interruptedAction: InterruptedAction | null;
  /** Whether the OTP enrollment dialog is showing. */
  showEnrollment: boolean;
  /** Whether the OTP challenge dialog is showing. */
  showChallenge: boolean;
  /** Error message from the last OTP operation. */
  error: string | null;
  /** Whether an OTP operation is in progress. */
  isLoading: boolean;
}

// ============================================================================
// Store
// ============================================================================

const [state, setState] = createStore<OtpState>({
  enrollmentStatus: "disabled",
  otpRequired: false,
  verifiedUntil: null,
  interruptedAction: null,
  showEnrollment: false,
  showChallenge: false,
  error: null,
  isLoading: false,
});

/** Max age for an interrupted action before it's considered stale (5 min). */
const INTERRUPTED_ACTION_MAX_AGE_MS = 5 * 60 * 1000;

export const otpStore = {
  // === Getters ===

  get otpRequired(): boolean {
    return state.otpRequired;
  },

  get enrollmentStatus(): OtpEnrollmentStatus {
    return state.enrollmentStatus;
  },

  get isVerified(): boolean {
    if (!state.verifiedUntil) return false;
    return Date.now() < state.verifiedUntil;
  },

  get showEnrollment(): boolean {
    return state.showEnrollment;
  },

  get showChallenge(): boolean {
    return state.showChallenge;
  },

  get error(): string | null {
    return state.error;
  },

  get isLoading(): boolean {
    return state.isLoading;
  },

  get interruptedAction(): InterruptedAction | null {
    const action = state.interruptedAction;
    if (!action) return null;
    if (Date.now() - action.createdAt > INTERRUPTED_ACTION_MAX_AGE_MS) {
      setState("interruptedAction", null);
      return null;
    }
    return action;
  },

  /**
   * Check if private model use requires OTP and the user hasn't verified.
   * Returns the gate reason, or null if access is allowed.
   */
  gatePrivateModel(): "enroll" | "challenge" | null {
    if (!state.otpRequired) return null;
    if (state.enrollmentStatus === "not_enrolled") return "enroll";
    if (!this.isVerified) return "challenge";
    return null;
  },

  // === Actions ===

  /** Refresh OTP status from the backend. */
  async refreshStatus(): Promise<void> {
    try {
      const status: OtpStatus = await getOtpStatus();
      setState({
        enrollmentStatus: status.enrollment_status,
        otpRequired: status.otp_required,
        verifiedUntil: status.verified_until,
        error: null,
      });
    } catch (error) {
      // OTP service unavailable — don't block non-private models.
      // Keep existing state; the backend will deny if needed.
      console.warn("[OTP] Failed to refresh status:", error);
    }
  },

  /** Update local state after successful verification. */
  setVerified(verifiedUntil: number): void {
    setState({
      verifiedUntil,
      enrollmentStatus: "enrolled",
      showEnrollment: false,
      showChallenge: false,
      error: null,
    });
  },

  /** Store an interrupted action for resume after verification. */
  setInterruptedAction(action: InterruptedAction): void {
    setState("interruptedAction", action);
  },

  /** Consume and clear the interrupted action (for resume). */
  consumeInterruptedAction(): InterruptedAction | null {
    const action = this.interruptedAction;
    setState("interruptedAction", null);
    return action;
  },

  /** Show the enrollment dialog. */
  openEnrollment(): void {
    setState({ showEnrollment: true, showChallenge: false, error: null });
  },

  /** Show the challenge dialog. */
  openChallenge(): void {
    setState({ showChallenge: true, showEnrollment: false, error: null });
  },

  /** Close all OTP dialogs. */
  closeDialogs(): void {
    setState({
      showEnrollment: false,
      showChallenge: false,
      error: null,
      interruptedAction: null,
    });
  },

  setError(error: string | null): void {
    setState("error", error);
  },

  setLoading(loading: boolean): void {
    setState("isLoading", loading);
  },

  /** Apply OTP status from the org policy (called during auth init). */
  applyPolicy(policy: { otp_required_for_private_models?: boolean }): void {
    setState(
      "otpRequired",
      policy.otp_required_for_private_models ?? false,
    );
  },

  /** Clear all OTP state (e.g. on logout). */
  clear(): void {
    setState({
      enrollmentStatus: "disabled",
      otpRequired: false,
      verifiedUntil: null,
      interruptedAction: null,
      showEnrollment: false,
      showChallenge: false,
      error: null,
      isLoading: false,
    });
  },
};
