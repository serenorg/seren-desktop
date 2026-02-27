// ABOUTME: USDC balance query via Thirdweb contract reads.
// ABOUTME: Reads balanceOf on Base mainnet USDC contract.

import { getContract, readContract } from "thirdweb";
import { base } from "thirdweb/chains";
import { thirdwebClient } from "@/lib/thirdweb";

const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;

export interface UsdcBalanceResult {
  /** Human-readable balance like "$1.50" */
  balance: string;
  /** Raw balance string in smallest unit (e.g., "1500000") */
  balanceRaw: string;
  network: string;
}

/**
 * Get the USDC balance for an address on Base mainnet.
 */
export async function getUsdcBalance(
  address: string,
): Promise<UsdcBalanceResult> {
  const contract = getContract({
    client: thirdwebClient,
    chain: base,
    address: BASE_USDC_ADDRESS,
  });

  const raw = await readContract({
    contract,
    method: "function balanceOf(address account) view returns (uint256)",
    params: [address as `0x${string}`],
  });

  const balanceRaw = raw.toString();
  const whole = raw / BigInt(10 ** USDC_DECIMALS);
  const fraction = raw % BigInt(10 ** USDC_DECIMALS);
  const fractionStr = fraction.toString().padStart(USDC_DECIMALS, "0");
  const balance = `$${whole}.${fractionStr.slice(0, 2)}`;

  return {
    balance,
    balanceRaw,
    network: "Base",
  };
}
