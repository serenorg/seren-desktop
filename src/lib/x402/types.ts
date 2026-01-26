// ABOUTME: TypeScript types for x402 payment protocol.
// ABOUTME: Defines payment requirements, options, and response structures.

/**
 * Resource information from 402 response.
 */
export interface X402ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

/**
 * x402 payment option from 402 response.
 */
export interface X402PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/**
 * Insufficient credit error details.
 */
export interface InsufficientCredit {
  minimumRequired: string;
  currentBalance: string;
}

/**
 * Parsed payment requirements from a 402 response.
 */
export interface PaymentRequirements {
  x402Version?: number;
  resource?: X402ResourceInfo;
  accepts: PaymentOption[];
  insufficientCredit?: InsufficientCredit;
  error?: string;
}

/**
 * Payment option type.
 */
export type PaymentOption =
  | { type: "x402"; option: X402PaymentOption }
  | { type: "prepaid" };

/**
 * Parse a 402 response body into payment requirements.
 */
export function parsePaymentRequirements(body: string): PaymentRequirements {
  const data = JSON.parse(body);

  // Check for prepaid/credits insufficient balance shape
  if (data.minimumRequired !== undefined && data.currentBalance !== undefined) {
    return {
      accepts: [{ type: "prepaid" }],
      insufficientCredit: {
        minimumRequired: data.minimumRequired,
        currentBalance: data.currentBalance,
      },
      error: data.error,
    };
  }

  const version = data.x402Version;
  if (!version) {
    throw new Error("Missing x402Version in 402 response");
  }

  if (version === 1) {
    return parseV1(data);
  } else if (version === 2) {
    return parseV2(data);
  } else {
    throw new Error(`Unsupported x402Version: ${version}`);
  }
}

interface V1PaymentOption {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface V1Response {
  x402Version: number;
  error: string;
  accepts: V1PaymentOption[];
}

function parseV1(data: V1Response): PaymentRequirements {
  const firstOption = data.accepts[0];
  const resource: X402ResourceInfo | undefined = firstOption
    ? {
        url: firstOption.resource,
        description: firstOption.description,
        mimeType: firstOption.mimeType || "application/json",
      }
    : undefined;

  const accepts: PaymentOption[] = data.accepts.map((opt) => ({
    type: "x402" as const,
    option: {
      scheme: opt.scheme,
      network: opt.network,
      asset: opt.asset,
      amount: opt.maxAmountRequired,
      payTo: opt.payTo,
      maxTimeoutSeconds: opt.maxTimeoutSeconds,
      extra: opt.extra,
    },
  }));

  return {
    x402Version: 1,
    resource,
    accepts,
    error: data.error,
  };
}

interface V2Response {
  x402Version: number;
  resource?: X402ResourceInfo;
  accepts: X402PaymentOption[];
  error?: string;
}

function parseV2(data: V2Response): PaymentRequirements {
  return {
    x402Version: 2,
    resource: data.resource,
    accepts: data.accepts.map((opt) => ({
      type: "x402" as const,
      option: opt,
    })),
    error: data.error,
  };
}

/**
 * Check if payment requirements include x402 option.
 */
export function hasX402Option(requirements: PaymentRequirements): boolean {
  return requirements.accepts.some((a) => a.type === "x402");
}

/**
 * Get the first x402 payment option, if any.
 */
export function getX402Option(
  requirements: PaymentRequirements
): X402PaymentOption | null {
  for (const accept of requirements.accepts) {
    if (accept.type === "x402") {
      return accept.option;
    }
  }
  return null;
}

/**
 * Check if this is an insufficient credit error.
 */
export function isInsufficientCredit(requirements: PaymentRequirements): boolean {
  return requirements.insufficientCredit !== undefined;
}

/**
 * Format amount in USDC (6 decimals) to human-readable string.
 */
export function formatUsdcAmount(amountRaw: string): string {
  const amount = BigInt(amountRaw);
  const whole = amount / BigInt(1_000_000);
  const fraction = amount % BigInt(1_000_000);
  const fractionStr = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  if (fractionStr) {
    return `$${whole}.${fractionStr}`;
  }
  return `$${whole}`;
}

/**
 * Get chain name from network identifier.
 */
export function getChainName(network: string): string {
  // Handle eip155: prefix
  if (network.startsWith("eip155:")) {
    const chainId = network.slice(7);
    switch (chainId) {
      case "1":
        return "Ethereum";
      case "8453":
        return "Base";
      case "43114":
        return "Avalanche";
      case "11155111":
        return "Ethereum Sepolia";
      case "84532":
        return "Base Sepolia";
      case "43113":
        return "Avalanche Fuji";
      default:
        return `Chain ${chainId}`;
    }
  }

  // Handle named networks
  switch (network) {
    case "base":
      return "Base";
    case "base-sepolia":
      return "Base Sepolia";
    case "ethereum":
      return "Ethereum";
    case "ethereum-sepolia":
      return "Ethereum Sepolia";
    case "avalanche":
      return "Avalanche";
    case "avalanche-fuji":
      return "Avalanche Fuji";
    default:
      return network;
  }
}
