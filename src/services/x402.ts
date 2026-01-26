// ABOUTME: x402 payment service for handling USDC payments to MCP servers.
// ABOUTME: Supports both SerenBucks (prepaid) and crypto wallet payment methods.

import { createRoot, createSignal } from "solid-js";
import { getCryptoWalletAddress, signX402Payment } from "@/lib/tauri-bridge";
import {
  formatUsdcAmount,
  getChainName,
  getX402Option,
  hasX402Option,
  type PaymentRequirements,
  parsePaymentRequirements,
} from "@/lib/x402";
import { settingsState } from "@/stores/settings.store";

/**
 * Payment method choice.
 */
export type PaymentMethod = "serenbucks" | "crypto";

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
  resolve: (result: { approved: boolean; method?: PaymentMethod }) => void;
}

/**
 * Result of an x402 payment attempt.
 */
export interface X402PaymentResult {
  success: boolean;
  paymentHeader?: string;
  method?: PaymentMethod;
  error?: string;
}

/**
 * Create the x402 payment service.
 */
function createX402Service() {
  const [pendingPayment, setPendingPayment] =
    createSignal<PendingPayment | null>(null);
  const [isProcessing, setIsProcessing] = createSignal(false);
  const [selectedMethod, setSelectedMethod] =
    createSignal<PaymentMethod | null>(null);

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
    requirements: PaymentRequirements,
  ): Promise<{ approved: boolean; method?: PaymentMethod }> {
    const x402Option = getX402Option(requirements);

    // For display, use x402 option info if available, otherwise use generic values
    const amount = x402Option?.amount ?? "0";
    const recipient = x402Option?.payTo ?? "";
    const network = x402Option?.network ?? "";

    return new Promise((resolve) => {
      const id = `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      setPendingPayment({
        id,
        serverName,
        toolName,
        amount,
        amountFormatted: formatUsdcAmount(amount),
        recipient,
        network,
        chainName: getChainName(network),
        requirements,
        resolve: (result) => {
          setPendingPayment(null);
          setSelectedMethod(result.method ?? null);
          resolve(result);
        },
      });
    });
  }

  /**
   * Sign an x402 payment and get the payment header.
   */
  async function signPayment(
    requirements: PaymentRequirements,
  ): Promise<X402PaymentResult> {
    setIsProcessing(true);

    try {
      // Check if wallet is configured
      const address = await getCryptoWalletAddress();
      if (!address) {
        return {
          success: false,
          error:
            "Crypto wallet not configured. Please add your private key in Settings > Wallet.",
        };
      }

      // Sign the payment via Tauri IPC
      const requirementsJson = JSON.stringify(requirements);
      const result = await signX402Payment(requirementsJson);

      return {
        success: true,
        paymentHeader: result.headerValue,
        method: "crypto",
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Payment signing failed",
      };
    } finally {
      setIsProcessing(false);
    }
  }

  /**
   * Handle a SerenBucks payment (prepaid credits).
   * This doesn't need a payment header - the server handles it via auth token.
   */
  async function handleSerenBucksPayment(): Promise<X402PaymentResult> {
    setIsProcessing(true);
    try {
      // SerenBucks payments are handled server-side via the auth token
      // We just need to signal that we want to use this method
      return {
        success: true,
        method: "serenbucks",
        // No payment header needed - server uses auth token
      };
    } finally {
      setIsProcessing(false);
    }
  }

  /**
   * Handle an x402 payment required error.
   *
   * Returns the payment result including which method was used.
   */
  async function handlePaymentRequired(
    serverName: string,
    toolName: string,
    error: unknown,
  ): Promise<X402PaymentResult | null> {
    // Extract payment requirements from the error
    const requirements = extractRequirements(error);
    if (!requirements) {
      console.error("Could not parse payment requirements from error:", error);
      return null;
    }

    const x402Option = getX402Option(requirements);
    const hasPrepaid = requirements.accepts.some((a) => a.type === "prepaid");
    const hasCrypto = hasX402Option(requirements);

    // If no valid payment options, fail
    if (!hasPrepaid && !hasCrypto) {
      console.error("No valid payment options in requirements");
      return null;
    }

    // Check for auto-approve with crypto (only if crypto is available and preferred)
    if (
      hasCrypto &&
      x402Option &&
      settingsState.app.preferredPaymentMethod === "crypto"
    ) {
      const amount = x402Option.amount;
      if (shouldAutoApprove(amount)) {
        return await signPayment(requirements);
      }
    }

    // Request user approval with method selection
    const result = await requestApproval(serverName, toolName, requirements);
    if (!result.approved) {
      return null;
    }

    // Process payment based on selected method
    if (result.method === "crypto") {
      return await signPayment(requirements);
    } else if (result.method === "serenbucks") {
      return await handleSerenBucksPayment();
    }

    return null;
  }

  /**
   * Approve the current pending payment (legacy - uses default method).
   */
  function approvePendingPayment(): void {
    const payment = pendingPayment();
    if (payment) {
      payment.resolve({
        approved: true,
        method: settingsState.app.preferredPaymentMethod,
      });
    }
  }

  /**
   * Approve the current pending payment with a specific method.
   */
  function approveWithMethod(method: PaymentMethod): void {
    const payment = pendingPayment();
    if (payment) {
      payment.resolve({ approved: true, method });
    }
  }

  /**
   * Decline the current pending payment.
   */
  function declinePendingPayment(): void {
    const payment = pendingPayment();
    if (payment) {
      payment.resolve({ approved: false });
    }
  }

  return {
    pendingPayment,
    isProcessing,
    selectedMethod,
    isX402Error,
    extractRequirements,
    shouldAutoApprove,
    handlePaymentRequired,
    signPayment,
    handleSerenBucksPayment,
    approvePendingPayment,
    approveWithMethod,
    declinePendingPayment,
  };
}

// Export singleton instance
export const x402Service = createRoot(createX402Service);
