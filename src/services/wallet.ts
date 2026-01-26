// ABOUTME: Wallet service for fetching and managing SerenBucks balance.
// ABOUTME: Uses generated hey-api SDK for type-safe API calls.

import { createDeposit, getTransactions, getWalletBalance } from "@/api";

// Re-export generated types directly
export type {
  DepositResponse as TopUpCheckout,
  WalletBalanceResponse as WalletBalance,
  WalletTransactionHistoryResponse as TransactionsResponse,
  WalletTransactionResponse as Transaction,
} from "@/api";

/**
 * Crypto deposit response.
 * Note: Not yet in OpenAPI spec.
 */
export interface CryptoDepositInfo {
  depositAddress: string;
  network: string;
  chainId: number;
  amount: string;
  amountUsd: number;
  expiresAt: string;
  reference: string;
}

/**
 * Fetch the current wallet balance from the API.
 * @throws Error if not authenticated or network error
 */
export async function fetchBalance() {
  const { data, error } = await getWalletBalance({ throwOnError: false });

  if (error) {
    throw new Error("Failed to fetch balance");
  }

  if (!data?.data) {
    throw new Error("No balance data returned");
  }

  return data.data;
}

/**
 * Initiate a top-up checkout session.
 * @param amount Amount in USD to top up (will be converted to cents)
 * @throws Error if not authenticated or network error
 */
export async function initiateTopUp(amount: number) {
  const { data, error } = await createDeposit({
    body: { amount_cents: Math.round(amount * 100) },
    throwOnError: false,
  });

  if (error) {
    throw new Error("Failed to initiate top-up");
  }

  if (!data?.data) {
    throw new Error("No checkout data returned");
  }

  return data.data;
}

/**
 * Open the Stripe checkout URL in the default browser.
 */
export async function openCheckout(checkoutUrl: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(checkoutUrl);
}

/**
 * Initiate a crypto deposit.
 * Note: Not yet in OpenAPI spec - placeholder implementation.
 */
export async function initiateCryptoDeposit(
  _amount: number,
): Promise<CryptoDepositInfo> {
  throw new Error("Crypto deposits not yet supported");
}

/**
 * Fetch transaction history from the API.
 * @param limit Number of transactions to fetch
 * @param offset Pagination offset
 * @throws Error if not authenticated or network error
 */
export async function fetchTransactions(limit = 20, offset = 0) {
  const { data, error } = await getTransactions({
    query: { limit, offset },
    throwOnError: false,
  });

  if (error) {
    throw new Error("Failed to fetch transactions");
  }

  if (!data?.data) {
    throw new Error("No transaction data returned");
  }

  return data.data;
}
