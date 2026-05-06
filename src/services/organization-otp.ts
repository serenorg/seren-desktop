import { createRoot, createSignal } from "solid-js";
import {
  beginOrganizationOtpEnrollment,
  confirmOrganizationOtpEnrollment,
  type OrganizationOtpEnrollmentChallenge,
  type OrganizationOtpEnrollmentStatus,
  type OrganizationOtpScope,
  type OrganizationOtpStatus,
  verifyOrganizationOtpScope,
} from "@/api";
import { apiBase } from "@/lib/config";
import { toDataURL } from "@/lib/qrcode-shim";

export type {
  OrganizationOtpEnrollmentChallenge,
  OrganizationOtpEnrollmentStatus,
  OrganizationOtpScope,
  OrganizationOtpStatus,
};

export type OrganizationOtpDenialReason =
  | "policy_required"
  | "unenrolled"
  | "expired"
  | "locked";

export interface OrganizationOtpDenialResponse {
  error: "otp_required";
  message: string;
  scope: OrganizationOtpScope;
  reason: OrganizationOtpDenialReason;
}

type PendingPhase = "enroll" | "verify" | "locked";

interface PendingOtpRequest {
  denial: OrganizationOtpDenialResponse;
  challenge: OrganizationOtpEnrollmentChallenge | null;
  qrCodeDataUrl: string | null;
  phase: PendingPhase;
  helperText: string | null;
  resolve: (approved: boolean) => void;
}

function scopeLabel(scope: OrganizationOtpScope): string {
  switch (scope) {
    case "org_sign_in":
      return "organization access";
    case "organization_security_manage":
      return "organization security settings";
    case "private_models.access":
      return "private model access";
  }
}

function shouldSkipOtp(input: RequestInfo | URL): boolean {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  try {
    const { pathname } = new URL(raw, apiBase);
    const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
    return (
      normalizedPathname.includes("/otp") ||
      normalizedPathname.endsWith("/auth/login") ||
      normalizedPathname.endsWith("/auth/refresh") ||
      normalizedPathname.endsWith("/auth/signup")
    );
  } catch {
    return false;
  }
}

async function getOtpJson(
  response: Response,
): Promise<OrganizationOtpDenialResponse | null> {
  try {
    const payload = (await response
      .clone()
      .json()) as Partial<OrganizationOtpDenialResponse>;
    if (
      payload?.error === "otp_required" &&
      typeof payload.message === "string" &&
      typeof payload.scope === "string" &&
      typeof payload.reason === "string"
    ) {
      return payload as OrganizationOtpDenialResponse;
    }
  } catch {
    // Ignore non-JSON 403 responses.
  }

  return null;
}

async function beginEnrollment(): Promise<OrganizationOtpEnrollmentChallenge> {
  const { data, error, response } = await beginOrganizationOtpEnrollment({
    path: { organization_id: "default" },
    throwOnError: false,
  });
  if (error || !data?.data) {
    const message = await response?.text().catch(() => "");
    throw new Error(
      `Failed to begin organization OTP enrollment (${response?.status ?? "?"}): ${message}`,
    );
  }
  return data.data;
}

async function confirmEnrollment(code: string): Promise<OrganizationOtpStatus> {
  const { data, error, response } = await confirmOrganizationOtpEnrollment({
    path: { organization_id: "default" },
    body: { code },
    throwOnError: false,
  });
  if (error || !data?.data) {
    const message = await response?.text().catch(() => "");
    throw new Error(
      `Failed to confirm organization OTP enrollment (${response?.status ?? "?"}): ${message}`,
    );
  }
  return data.data;
}

async function verifyScope(
  scope: OrganizationOtpScope,
  code: string,
): Promise<OrganizationOtpStatus> {
  const { data, error, response } = await verifyOrganizationOtpScope({
    path: { organization_id: "default" },
    body: { code, scope },
    throwOnError: false,
  });
  if (error || !data?.data) {
    if (response) {
      const otpError = await getOtpJson(response);
      if (otpError) {
        throw new Error(otpError.message);
      }
    }
    const message = await response?.text().catch(() => "");
    throw new Error(
      `Failed to verify organization OTP (${response?.status ?? "?"}): ${message}`,
    );
  }
  return data.data;
}

function createOrganizationOtpService() {
  const [pendingRequest, setPendingRequest] =
    createSignal<PendingOtpRequest | null>(null);
  const [isProcessing, setIsProcessing] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);

  async function requestApproval(
    denial: OrganizationOtpDenialResponse,
  ): Promise<boolean> {
    const existing = pendingRequest();
    if (existing) {
      return new Promise((resolve) => {
        const existingResolve = existing.resolve;
        setPendingRequest({
          ...existing,
          resolve: (approved) => {
            existingResolve(approved);
            resolve(approved);
          },
        });
      });
    }

    let challenge: OrganizationOtpEnrollmentChallenge | null = null;
    let qrCodeDataUrl: string | null = null;
    let phase: PendingPhase = "verify";
    let helperText: string | null = null;

    if (denial.reason === "unenrolled") {
      try {
        challenge = await beginEnrollment();
        qrCodeDataUrl = await toDataURL(challenge.otpauth_uri, {
          margin: 1,
          width: 220,
        });
      } catch (error) {
        phase = "locked";
        helperText =
          error instanceof Error
            ? error.message
            : "Failed to begin OTP enrollment.";

        return new Promise((resolve) => {
          setPendingRequest({
            denial,
            challenge: null,
            qrCodeDataUrl: null,
            phase,
            helperText,
            resolve: (approved) => {
              setPendingRequest(null);
              setErrorMessage(null);
              resolve(approved);
            },
          });
        });
      }
      phase = "enroll";
      helperText = `Scan the QR code or enter the key below, then enter a 6-digit code to enroll for ${scopeLabel(denial.scope)}.`;
    } else if (denial.reason === "expired") {
      helperText = `Enter a fresh 6-digit code to continue to ${scopeLabel(denial.scope)}.`;
    } else if (denial.reason === "policy_required") {
      helperText = `This organization requires OTP before ${scopeLabel(denial.scope)}.`;
    } else if (denial.reason === "locked") {
      phase = "locked";
      helperText = denial.message;
    } else {
      helperText = denial.message;
    }

    setErrorMessage(null);

    return new Promise((resolve) => {
      setPendingRequest({
        denial,
        challenge,
        qrCodeDataUrl,
        phase,
        helperText,
        resolve: (approved) => {
          setPendingRequest(null);
          setErrorMessage(null);
          resolve(approved);
        },
      });
    });
  }

  async function submitCode(code: string): Promise<void> {
    const pending = pendingRequest();
    if (!pending || isProcessing()) {
      return;
    }

    const normalized = code.replace(/\D/g, "");
    if (normalized.length !== 6) {
      setErrorMessage("Enter a valid 6-digit code.");
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      if (pending.phase === "enroll") {
        await confirmEnrollment(normalized);
        setPendingRequest({
          ...pending,
          phase: "verify",
          challenge: null,
          qrCodeDataUrl: null,
          helperText: `Enrollment complete. Enter a fresh 6-digit code to continue to ${scopeLabel(pending.denial.scope)}.`,
        });
        return;
      }

      await verifyScope(pending.denial.scope, normalized);
      pending.resolve(true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "OTP verification failed";
      setErrorMessage(message);
    } finally {
      setIsProcessing(false);
    }
  }

  function cancel(): void {
    const pending = pendingRequest();
    if (!pending) {
      return;
    }

    pending.resolve(false);
  }

  return {
    cancel,
    errorMessage,
    isOtpRequiredResponse: getOtpJson,
    isProcessing,
    pendingRequest,
    requestApproval,
    scopeLabel,
    shouldSkipOtp,
    submitCode,
  };
}

export const organizationOtpService = createRoot(createOrganizationOtpService);
