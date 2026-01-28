// ABOUTME: Service for checking and claiming daily SerenBucks credits.
// ABOUTME: Wraps generated SDK calls with error handling.

import { checkDailyEligibility, claimDaily } from "@/api";
import type {
  DailyClaimEligibilityResponse,
  DailyClaimResponse,
} from "@/api/generated/types.gen";

export type { DailyClaimEligibilityResponse, DailyClaimResponse };

/**
 * Check if the current user is eligible to claim daily credits.
 */
export async function fetchDailyEligibility(): Promise<DailyClaimEligibilityResponse> {
  const { data, error } = await checkDailyEligibility({
    throwOnError: false,
  });

  if (error) {
    throw new Error("Failed to check daily claim eligibility");
  }

  if (!data?.data) {
    throw new Error("No eligibility data returned");
  }

  return data.data;
}

/**
 * Claim daily free credits.
 */
export async function claimDailyCredits(): Promise<DailyClaimResponse> {
  const { data, error } = await claimDaily({ throwOnError: false });

  if (error) {
    throw new Error("Failed to claim daily credits");
  }

  if (!data?.data) {
    throw new Error("No claim data returned");
  }

  return data.data;
}
