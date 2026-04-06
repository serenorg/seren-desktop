// ABOUTME: OTP service for private-model step-up verification.
// ABOUTME: Fetches status, initiates enrollment, and verifies TOTP challenges.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";
import { getToken } from "@/services/auth";

export type OtpEnrollmentStatus = "not_enrolled" | "enrolled" | "disabled";
export type OtpVerificationTtl = "30m" | "8h" | "12h";

export interface OtpStatus {
  enrollment_status: OtpEnrollmentStatus;
  otp_required: boolean;
  verified_until: number | null;
  verification_ttl: OtpVerificationTtl | null;
}

export interface OtpEnrollmentResponse {
  secret: string;
  qr_uri: string;
}

export interface OtpVerifyResponse {
  verified_until: number;
}

export type OtpDenialReason =
  | "otp_not_enrolled"
  | "otp_expired"
  | "otp_policy_required"
  | "otp_invalid_code"
  | "otp_rate_limited";

async function authHeaders(url: string): Promise<HeadersInit> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!shouldUseRustGatewayAuth(url)) {
    const token = await getToken();
    if (!token) throw new Error("Not authenticated");
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Fetch OTP status for the current user in their default org. */
export async function getOtpStatus(): Promise<OtpStatus> {
  const url = `${apiBase}/auth/otp/status`;
  const response = await appFetch(url, { headers: await authHeaders(url) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OTP status failed (${response.status}): ${text}`);
  }
  return (await response.json()) as OtpStatus;
}

/** Begin TOTP enrollment. Returns secret + QR URI. */
export async function beginEnrollment(): Promise<OtpEnrollmentResponse> {
  const url = `${apiBase}/auth/otp/enroll`;
  const response = await appFetch(url, {
    method: "POST",
    headers: await authHeaders(url),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OTP enrollment failed (${response.status}): ${text}`);
  }
  return (await response.json()) as OtpEnrollmentResponse;
}

/** Confirm enrollment with the first valid TOTP code. */
export async function confirmEnrollment(code: string): Promise<OtpVerifyResponse> {
  const url = `${apiBase}/auth/otp/enroll/confirm`;
  const response = await appFetch(url, {
    method: "POST",
    headers: await authHeaders(url),
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OTP confirm failed (${response.status}): ${text}`);
  }
  return (await response.json()) as OtpVerifyResponse;
}

/** Verify a TOTP code for re-verification challenge. */
export async function verifyOtp(code: string): Promise<OtpVerifyResponse> {
  const url = `${apiBase}/auth/otp/verify`;
  const response = await appFetch(url, {
    method: "POST",
    headers: await authHeaders(url),
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OTP verify failed (${response.status}): ${text}`);
  }
  return (await response.json()) as OtpVerifyResponse;
}

/** Parse a backend denial into a typed reason. */
export function parseOtpDenial(message: string): OtpDenialReason | null {
  const lower = message.toLowerCase();
  if (lower.includes("not_enrolled") || lower.includes("not enrolled"))
    return "otp_not_enrolled";
  if (lower.includes("expired") || lower.includes("verification window"))
    return "otp_expired";
  if (lower.includes("otp_required") || lower.includes("otp required"))
    return "otp_policy_required";
  if (lower.includes("invalid") && lower.includes("code"))
    return "otp_invalid_code";
  if (lower.includes("rate") && lower.includes("limit"))
    return "otp_rate_limited";
  return null;
}
