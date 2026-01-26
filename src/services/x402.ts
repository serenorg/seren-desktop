// ABOUTME: x402 payment service for handling USDC payments to MCP servers.
// ABOUTME: Detects 402 responses, signs payments, and retries with payment headers.

import { createSignal, createRoot } from "solid-js";
import { signX402Payment, getCryptoWalletAddress } from "@/lib/tauri-bridge";
import {
  parsePaymentRequirements,
  hasX402Option,
  getX402Option,
  formatUsdcAmount,
  getChainName,
  type PaymentRequirements,
} from "@/lib/x402";
import { settingsState } from "@/stores/settings.store";

/**
 * Payment request waiting for user approval.
 */
export interface PendingPayment {
  id: string;
  serverName: string;
  toolName: string;
  amount: string;
  amountFormatted: string;
  recipient: string;
  network: string;
  chainName: string;
  requirements: PaymentRequirements;
  resolve: (approved: boolean) => void;
}

/**
 * Result of an x402 payment attempt.
 */
export interface X402PaymentResult {
  success: boolean;
  paymentHeader?: string;
  error?: string;
}

/**
 * Create the x402 payment service.
 */
function createX402Service() {
  const [pendingPayment, setPendingPayment] = createSignal<PendingPayment | null>(null);
  const [isProcessing, setIsProcessing] = createSignal(false);

  /**
   * Check if an error is an x402 payment required error.
   */
  function isX402Error(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes("402") || message.includes("payment required");
    }
    return false;
  }

  /**
   * Extract payment requirements from an error.
   */
  function extractRequirements(error: unknown): PaymentRequirements | null {
    if (!(error instanceof Error)) return null;

    // Try to parse the error message as JSON (might be the full 402 response body)
    try {
      // Look for JSON in the error message
      const jsonMatch = error.message.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return parsePaymentRequirements(jsonMatch[0]);
      }
    } catch {
      // Not a JSON error
    }

    return null;
  }

  /**
   * Check if a payment amount is below the auto-approve threshold.
   */
  function shouldAutoApprove(amountUsdc: string): boolean {
    const threshold = settingsState.app.cryptoAutoApproveLimit;
    const amountUsd = Number.parseFloat(amountUsdc) / 1_000_000; // USDC has 6 decimals
    return amountUsd <= threshold;
  }

  /**
   * Request user approval for a payment.
   */
  async function requestApproval(
    serverName: string,
    toolName: string,
    requirements: PaymentRequirements
  ): Promise<boolean> {
    const x402Option = getX402Option(requirements);
    if (!x402Option) {
      console.error("No x402 payment option found in requirements");
      return false;
    }

    return new Promise((resolve) => {
      const id = `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      setPendingPayment({
        id,
        serverName,
        toolName,
        amount: x402Option.amount,
        amountFormatted: formatUsdcAmount(x402Option.amount),
        recipient: x402Option.payTo,
        network: x402Option.network,
        chainName: getChainName(x402Option.network),
        requirements,
        resolve: (approved: boolean) => {
          setPendingPayment(null);
          resolve(approved);
        },
      });
    });
  }

  /**
   * Sign an x402 payment and get the payment header.
   */
  async function signPayment(requirements: PaymentRequirements): Promise<X402PaymentResult> {
    setIsProcessing(true);

    try {
      // Check if wallet is configured
      const address = await getCryptoWalletAddress();
      if (!address) {
        return {
          success: false,
          error: "Crypto wallet not configured. Please add your private key in Settings > Wallet.",
        };
      }

      // Sign the payment via Tauri IPC
      const requirementsJson = JSON.stringify(requirements);
      const result = await signX402Payment(requirementsJson);

      return {
        success: true,
        paymentHeader: result.headerValue,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Payment signing failed",
      };
    } finally {
      setIsProcessing(false);
    }
  }

  /**
   * Handle an x402 payment required error.
   *
   * Returns the payment header if successful, or null if payment was declined/failed.
   */
  async function handlePaymentRequired(
    serverName: string,
    toolName: string,
    error: unknown
  ): Promise<string | null> {
    // Extract payment requirements from the error
    const requirements = extractRequirements(error);
    if (!requirements) {
      console.error("Could not parse payment requirements from error:", error);
      return null;
    }

    // Check for x402 payment option
    if (!hasX402Option(requirements)) {
      console.error("No x402 payment option in requirements");
      return null;
    }

    const x402Option = getX402Option(requirements);
    if (!x402Option) {
      return null;
    }

    const amount = x402Option.amount;

    // Check if we should auto-approve
    if (shouldAutoApprove(amount)) {
      const result = await signPayment(requirements);
      return result.success ? result.paymentHeader ?? null : null;
    }

    // Request user approval
    const approved = await requestApproval(serverName, toolName, requirements);
    if (!approved) {
      return null;
    }

    // Sign the payment
    const result = await signPayment(requirements);
    return result.success ? result.paymentHeader ?? null : null;
  }

  /**
   * Approve the current pending payment.
   */
  function approvePendingPayment(): void {
    const payment = pendingPayment();
    if (payment) {
      payment.resolve(true);
    }
  }

  /**
   * Decline the current pending payment.
   */
  function declinePendingPayment(): void {
    const payment = pendingPayment();
    if (payment) {
      payment.resolve(false);
    }
  }

  return {
    pendingPayment,
    isProcessing,
    isX402Error,
    extractRequirements,
    shouldAutoApprove,
    handlePaymentRequired,
    signPayment,
    approvePendingPayment,
    declinePendingPayment,
  };
}

// Export singleton instance
export const x402Service = createRoot(createX402Service);
