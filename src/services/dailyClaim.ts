// ABOUTME: Service for checking and claiming daily SerenBucks credits.
// ABOUTME: Wraps generated SDK calls with error handling.

import { checkDailyEligibility, claimDaily } from "@/api";
import type {
  DailyClaimEligibilityResponse,
  DailyClaimResponse,
} from "@/api/generated/types.gen";

export type { DailyClaimResponse };

/**
 * Extended eligibility response that includes optional claim amount.
 * The claim_amount_usd field is added by the backend when available (see issue #226).
 * Falls back gracefully when the field is absent.
 */
export type DailyClaimEligibility = DailyClaimEligibilityResponse & {
  claim_amount_usd?: string | null;
};

/**
 * Check if the current user is eligible to claim daily credits.
 */
export async function fetchDailyEligibility(): Promise<DailyClaimEligibility> {
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
