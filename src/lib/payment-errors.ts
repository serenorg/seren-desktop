// ABOUTME: Shared payment error detection for UI components.
// ABOUTME: Identifies insufficient balance / 402 errors from error messages.

/** Patterns that indicate a payment or insufficient balance error. */
const PAYMENT_ERROR_PATTERNS = [
  /\b402\b/,
  /payment required/i,
  /insufficient.*balance/i,
  /insufficient.*credit/i,
  /insufficient.*fund/i,
  /not enough.*credit/i,
  /SerenBucks.*insufficient/i,
];

/**
 * Check if an error message indicates a payment/insufficient balance failure.
 * Use for messages already known to be errors (error events, API errors).
 */
export function isPaymentError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return PAYMENT_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}
