// ABOUTME: Wallet service for fetching and managing SerenBucks balance.
// ABOUTME: Communicates with the Seren Gateway API for balance operations.

import { API_BASE } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/tauri-bridge";

/**
 * Wallet balance response from the API.
 */
export interface WalletBalance {
  balance: number;
  currency: string;
  lastUpdated: string;
}

/**
 * Top-up checkout response (Stripe).
 */
export interface TopUpCheckout {
  checkoutUrl: string;
  sessionId: string;
}

/**
 * Crypto deposit response.
 */
export interface CryptoDepositInfo {
  depositAddress: string;
  network: string;
  chainId: number;
  amount: string; // USDC amount in 6 decimal format
  amountUsd: number;
  expiresAt: string;
  reference: string;
}

/**
 * Wallet API error.
 */
export interface WalletError {
  message: string;
  code?: string;
}

/**
 * Fetch the current wallet balance from the API.
 * @throws Error if not authenticated or network error
 */
export async function fetchBalance(): Promise<WalletBalance> {
  const token = await getToken();

  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await appFetch(`${API_BASE}/agent/wallet/balance`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 401) {
    throw new Error("Authentication expired. Please log in again.");
  }

  if (!response.ok) {
    const error: WalletError = await response.json().catch(() => ({
      message: "Failed to fetch balance",
    }));
    throw new Error(error.message);
  }

  return response.json();
}

/**
 * Initiate a top-up checkout session.
 * @param amount Amount in USD to top up
 * @throws Error if not authenticated or network error
 */
export async function initiateTopUp(amount: number): Promise<TopUpCheckout> {
  const token = await getToken();

  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await appFetch(`${API_BASE}/agent/wallet/deposit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amount }),
  });

  if (response.status === 401) {
    throw new Error("Authentication expired. Please log in again.");
  }

  if (!response.ok) {
    const error: WalletError = await response.json().catch(() => ({
      message: "Failed to initiate top-up",
    }));
    throw new Error(error.message);
  }

  return response.json();
}

/**
 * Open the Stripe checkout URL in the default browser.
 */
export async function openCheckout(checkoutUrl: string): Promise<void> {
  // Use Tauri's opener plugin to open URL in default browser
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(checkoutUrl);
}

/**
 * Initiate a crypto deposit to get deposit address and payment details.
 * @param amount Amount in USD to deposit
 * @throws Error if not authenticated or network error
 */
export async function initiateCryptoDeposit(amount: number): Promise<CryptoDepositInfo> {
  const token = await getToken();

  if (!token) {
    throw new Error("Not authenticated");
  }

  const response = await appFetch(`${API_BASE}/agent/wallet/deposit/crypto`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amount }),
  });

  if (response.status === 401) {
    throw new Error("Authentication expired. Please log in again.");
  }

  if (!response.ok) {
    const error: WalletError = await response.json().catch(() => ({
      message: "Failed to initiate crypto deposit",
    }));
    throw new Error(error.message);
  }

  return response.json();
}

/**
 * Transaction types.
 */
export type TransactionType = "deposit" | "charge" | "refund" | "auto_topup";

/**
 * Transaction record from the API.
 */
export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  description: string;
  createdAt: string;
  balance?: number;
}

/**
 * Transactions response from the API.
 */
export interface TransactionsResponse {
  transactions: Transaction[];
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Fetch transaction history from the API.
 * @param limit Number of transactions to fetch
 * @param cursor Pagination cursor
 * @throws Error if not authenticated or network error
 */
export async function fetchTransactions(
  limit = 20,
  cursor?: string
): Promise<TransactionsResponse> {
  const token = await getToken();

  if (!token) {
    throw new Error("Not authenticated");
  }

  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await fetch(
    `${API_BASE}/agent/wallet/transactions?${params}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (response.status === 401) {
    throw new Error("Authentication expired. Please log in again.");
  }

  if (!response.ok) {
    const error: WalletError = await response.json().catch(() => ({
      message: "Failed to fetch transactions",
    }));
    throw new Error(error.message);
  }

  return response.json();
}
