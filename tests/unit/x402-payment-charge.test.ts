// ABOUTME: Tests resolvePaymentCharge — the realized-cost parser that gates a lease's
// ABOUTME: monetary budget (#3193-G). A wrong amount/asset would mis-charge real money.

import { describe, expect, it } from "vitest";
import {
  type PaymentRequirements,
  resolvePaymentCharge,
} from "@/lib/x402";

function x402Requirements(
  amount: string,
  asset: string,
): PaymentRequirements {
  return {
    x402Version: 1,
    accepts: [
      {
        type: "x402",
        option: {
          scheme: "exact",
          network: "base",
          asset,
          amount,
          payTo: "0x0000000000000000000000000000000000000000",
          maxTimeoutSeconds: 60,
        },
      },
    ],
  };
}

describe("resolvePaymentCharge", () => {
  it("reads the amount and asset from the first x402 option", () => {
    const charge = resolvePaymentCharge(
      x402Requirements("2500000", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    );
    expect(charge).toEqual({
      micros: 2_500_000,
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    });
  });

  it("reads the prepaid minimum as a SerenBucks charge when only credit is accepted", () => {
    const requirements: PaymentRequirements = {
      accepts: [{ type: "prepaid" }],
      insufficientCredit: {
        minimumRequired: "1500000",
        currentBalance: "0",
      },
    };
    expect(resolvePaymentCharge(requirements)).toEqual({
      micros: 1_500_000,
      asset: "serenbucks",
    });
  });

  it("prefers the x402 option amount when both crypto and prepaid are offered", () => {
    const requirements = x402Requirements("750000", "USDC");
    requirements.accepts.push({ type: "prepaid" });
    expect(resolvePaymentCharge(requirements)?.micros).toBe(750_000);
  });

  it("refuses an amount that is not a safe integer count of micro-units", () => {
    // 10^18 wei-style value overflows JS safe-integer range — must not be metered
    // as a truncated (wrong) micro amount.
    expect(
      resolvePaymentCharge(x402Requirements("1000000000000000000", "USDC")),
    ).toBeNull();
  });

  it("refuses a non-numeric amount rather than metering NaN", () => {
    expect(resolvePaymentCharge(x402Requirements("not-a-number", "USDC"))).toBeNull();
  });

  it("returns null when no amount is present at all", () => {
    expect(resolvePaymentCharge({ accepts: [{ type: "prepaid" }] })).toBeNull();
  });
});
