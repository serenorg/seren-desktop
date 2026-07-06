// ABOUTME: Wallet service for fetching and managing SerenBucks balance.
// ABOUTME: Uses generated hey-api SDK for type-safe API calls.

import type {
  ReceivedTransferNotificationSummary,
  DepositResponse as TopUpCheckout,
  WalletTransactionResponse as Transaction,
  WalletTransactionHistoryResponse as TransactionsResponse,
  WalletBalanceResponse as WalletBalance,
  WalletTransferClaimResponse,
  WalletTransferDirection,
  WalletTransferExecuteResponse,
  WalletTransferListItem,
  WalletTransferListResponse,
  WalletTransferPreviewResponse,
  WalletTransferRecallResponse,
  WalletTransferRequest,
} from "@/api";
import {
  claimWalletTransfer,
  createDeposit,
  executeWalletTransfer,
  getTransactions,
  getWalletBalance,
  listWalletTransfers,
  markNotificationRead,
  previewWalletTransfer,
  recallWalletTransfer,
} from "@/api";

const TRANSACTIONS_TIMEOUT_MS = 15_000;

// Re-export generated types directly
export type {
  ReceivedTransferNotificationSummary,
  TopUpCheckout,
  Transaction,
  TransactionsResponse,
  WalletBalance,
  WalletTransferClaimResponse,
  WalletTransferDirection,
  WalletTransferExecuteResponse,
  WalletTransferListItem,
  WalletTransferListResponse,
  WalletTransferPreviewResponse,
  WalletTransferRecallResponse,
  WalletTransferRequest,
};

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

function apiErrorDetail(error: unknown, status?: number): string {
  let serverMessage: string | undefined;
  if (typeof error === "string") {
    serverMessage = error;
  } else if (error && typeof error === "object") {
    const body = error as Record<string, unknown>;
    if (typeof body.message === "string") {
      serverMessage = body.message;
    } else if (typeof body.error === "string") {
      serverMessage = body.error;
    } else if (typeof body.detail === "string") {
      serverMessage = body.detail;
    }
  }

  if (serverMessage) {
    return `${status ?? "request failed"} - ${serverMessage}`;
  }
  return status ? `HTTP ${status}` : "request failed";
}

function transferRequest(
  recipientEmail: string,
  amountCents: number,
  memo?: string | null,
): WalletTransferRequest {
  return {
    recipient_email: recipientEmail,
    amount_cents: amountCents,
    memo: memo ?? undefined,
  };
}

/**
 * Fetch the current wallet balance from the API.
 * @throws Error if not authenticated or network error
 */
export async function fetchBalance() {
  const { data, error } = await getWalletBalance({ throwOnError: false });

  if (error) {
    console.error("[Wallet] Error fetching balance:", error);
    const detail =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>).message ||
          (error as Record<string, unknown>).statusText ||
          JSON.stringify(error)
        : String(error);
    throw new Error(`Failed to fetch balance: ${detail}`);
  }

  if (!data?.data) {
    console.error(new Error("[Wallet] No balance data in response"));
    throw new Error("No balance data returned");
  }

  return data.data;
}

export async function markWalletNotificationRead(
  notificationId: string,
): Promise<void> {
  const { error, response } = await markNotificationRead({
    path: { notification_id: notificationId },
    throwOnError: false,
  });

  if (error) {
    const status = response?.status;
    throw new Error(
      `Failed to mark wallet notification read: ${apiErrorDetail(error, status)}`,
    );
  }
}

/**
 * Initiate a top-up checkout session.
 * @param amount Amount in USD to top up (will be converted to cents)
 * @throws Error if not authenticated or network error
 */
export async function initiateTopUp(amount: number) {
  const { data, error, response } = await createDeposit({
    body: { amount_cents: Math.round(amount * 100) },
    throwOnError: false,
  });

  if (error) {
    const status = response?.status;
    // The api.serendb.com 4xx/5xx is captured centrally by the hey-api client's
    // captureHttpFailure; this is a local diagnostic before the throw.
    console.warn("[Wallet] Error initiating top-up:", { status, error });
    throw new Error(
      `Failed to initiate top-up: ${apiErrorDetail(error, status)}`,
    );
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
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    TRANSACTIONS_TIMEOUT_MS,
  );

  try {
    const { data, error } = await getTransactions({
      query: { limit, offset },
      signal: controller.signal,
      throwOnError: false,
    });

    if (error) {
      throw new Error("Failed to fetch transactions");
    }

    if (!data?.data) {
      throw new Error("No transaction data returned");
    }

    return data.data;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Transaction request timed out");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Preview a wallet transfer before sending.
 */
export async function previewTransfer(
  recipientEmail: string,
  amountCents: number,
  memo?: string | null,
): Promise<WalletTransferPreviewResponse> {
  const { data, error, response } = await previewWalletTransfer({
    body: transferRequest(recipientEmail, amountCents, memo),
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Failed to preview transfer: ${apiErrorDetail(error, response?.status)}`,
    );
  }

  if (!data?.data) {
    throw new Error("No transfer preview data returned");
  }

  return data.data;
}

/**
 * Send a wallet transfer with a caller-owned idempotency key for safe retries.
 */
export async function sendTransfer(
  recipientEmail: string,
  amountCents: number,
  idempotencyKey: string,
  memo?: string | null,
): Promise<WalletTransferExecuteResponse> {
  const normalizedIdempotencyKey = idempotencyKey.trim();
  if (!normalizedIdempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  const { data, error, response } = await executeWalletTransfer({
    body: transferRequest(recipientEmail, amountCents, memo),
    headers: { "Idempotency-Key": normalizedIdempotencyKey },
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Failed to send transfer: ${apiErrorDetail(error, response?.status)}`,
    );
  }

  if (!data?.data) {
    throw new Error("No transfer data returned");
  }

  return data.data;
}

/**
 * List wallet transfers.
 */
export async function fetchTransfers(
  options: {
    direction?: WalletTransferDirection | null;
    status?: string | null;
    cursor?: string | null;
    limit?: number | null;
  } = {},
): Promise<WalletTransferListResponse> {
  const { data, error, response } = await listWalletTransfers({
    query: options,
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Failed to fetch transfers: ${apiErrorDetail(error, response?.status)}`,
    );
  }

  if (!data?.data) {
    throw new Error("No transfer list data returned");
  }

  return data.data;
}

/**
 * Claim a pending wallet transfer invite.
 */
export async function claimTransfer(
  token: string,
): Promise<WalletTransferClaimResponse> {
  const { data, error, response } = await claimWalletTransfer({
    body: { token },
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Failed to claim transfer: ${apiErrorDetail(error, response?.status)}`,
    );
  }

  if (!data?.data) {
    throw new Error("No transfer claim data returned");
  }

  return data.data;
}

/**
 * Recall a pending outbound wallet transfer.
 */
export async function recallTransfer(
  pendingTransferId: string,
): Promise<WalletTransferRecallResponse> {
  const { data, error, response } = await recallWalletTransfer({
    path: { pending_transfer_id: pendingTransferId },
    throwOnError: false,
  });

  if (error) {
    throw new Error(
      `Failed to recall transfer: ${apiErrorDetail(error, response?.status)}`,
    );
  }

  if (!data?.data) {
    throw new Error("No transfer recall data returned");
  }

  return data.data;
}
