// ABOUTME: Wallet service for fetching and managing SerenBucks balance.
// ABOUTME: Communicates with the Seren Gateway API for balance operations.

import { API_BASE } from "@/lib/config";
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
 * Top-up checkout response.
 */
export interface TopUpCheckout {
  checkoutUrl: string;
  sessionId: string;
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

  const response = await fetch(`${API_BASE}/v1/wallet/balance`, {
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

  const response = await fetch(`${API_BASE}/v1/wallet/topup`, {
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
  const { open } = await import("@tauri-apps/plugin-opener");
  await open(checkoutUrl);
}
