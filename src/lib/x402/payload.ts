// ABOUTME: x402 payment payload builder for EIP-712 signing via Thirdweb.
// ABOUTME: Ports the Rust payment.rs logic to TypeScript for frontend wallet signing.

import type { Account } from "thirdweb/wallets";
import type {
  PaymentRequirements,
  X402PaymentOption,
  X402ResourceInfo,
} from "./types";
import { getChainId } from "./types";

/**
 * EIP-712 typed data for TransferWithAuthorization (EIP-3009).
 */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

interface X402PayloadInner {
  signature: string;
  authorization: X402Authorization;
}

interface X402PaymentPayloadV2 {
  x402Version: number;
  resource: X402ResourceInfo;
  accepted: X402PaymentOption;
  payload: X402PayloadInner;
}

interface X402PaymentPayloadV1 {
  x402Version: number;
  scheme: string;
  network: string;
  payload: X402PayloadInner;
}

export interface SignedPayloadResult {
  headerName: string;
  headerValue: string;
  x402Version: number;
}

/**
 * Generate a random 32-byte nonce as a 0x-prefixed hex string.
 */
function generateRandomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}

/**
 * Extract EIP-712 domain parameters from the payment option's extra field.
 * Mirrors the Rust logic in payment.rs lines 418-509.
 */
function extractDomain(option: X402PaymentOption, chainId: number) {
  const extra = option.extra ?? {};
  const typedData = extra.eip712TypedData as
    | Record<string, unknown>
    | undefined;
  const typedDomain = typedData?.domain as Record<string, unknown> | undefined;

  // Verify verifyingContract matches asset
  const typedVerifyingContract = typedDomain?.verifyingContract as
    | string
    | undefined;
  if (
    typedVerifyingContract &&
    typedVerifyingContract.toLowerCase() !== option.asset.toLowerCase()
  ) {
    throw new Error(
      `Mismatched verifyingContract (${typedVerifyingContract}) for asset ${option.asset}`,
    );
  }
  const verifyingContract = typedVerifyingContract ?? option.asset;

  // Domain name with fallbacks
  const domainName =
    (extra.name as string | undefined) ??
    (typedDomain?.name as string | undefined) ??
    "USD Coin";

  // Domain version with fallbacks
  const domainVersion =
    (extra.version as string | undefined) ??
    (typedDomain?.version as string | undefined) ??
    "2";

  return {
    name: domainName,
    version: domainVersion,
    chainId: BigInt(chainId),
    verifyingContract: verifyingContract as `0x${string}`,
  };
}

/**
 * Extract validity window and nonce from the payment option's extra field.
 * Mirrors the Rust logic in payment.rs lines 465-502.
 */
function extractMessageParams(option: X402PaymentOption) {
  const extra = option.extra ?? {};
  const typedData = extra.eip712TypedData as
    | Record<string, unknown>
    | undefined;
  const typedMessage = typedData?.message as
    | Record<string, unknown>
    | undefined;

  const now = Math.floor(Date.now() / 1000);

  const validAfter =
    typedMessage?.validAfter !== undefined
      ? Number.parseInt(String(typedMessage.validAfter), 10)
      : now - 60;

  const validBefore =
    typedMessage?.validBefore !== undefined
      ? Number.parseInt(String(typedMessage.validBefore), 10)
      : now + option.maxTimeoutSeconds;

  const nonce =
    typeof typedMessage?.nonce === "string"
      ? (typedMessage.nonce as string)
      : generateRandomNonce();

  return { validAfter, validBefore, nonce };
}

/**
 * Build and sign an x402 payment payload using the connected wallet.
 *
 * @param account - Thirdweb Account from the connected wallet
 * @param requirementsJson - Raw JSON string of the 402 response body
 * @returns Signed payload ready for the payment header
 */
export async function buildSignedPayload(
  account: Account,
  requirements: PaymentRequirements,
  option: X402PaymentOption,
): Promise<SignedPayloadResult> {
  const version = requirements.x402Version;
  if (version === 1) {
    return buildSignedPayloadV1(account, option);
  }
  if (version === 2) {
    return buildSignedPayloadV2(account, requirements, option);
  }
  throw new Error(`Unsupported x402 version: ${version}`);
}

async function buildSignedPayloadV2(
  account: Account,
  requirements: PaymentRequirements,
  option: X402PaymentOption,
): Promise<SignedPayloadResult> {
  const fromAddress = account.address;

  const resource = requirements.resource;
  if (!resource) {
    throw new Error("Missing x402 resource info in 402 response");
  }

  const chainId = getChainId(option.network);
  if (chainId === null) {
    throw new Error(
      `Unsupported network for EIP-3009 signing: ${option.network}`,
    );
  }

  const domain = extractDomain(option, chainId);
  const { validAfter, validBefore, nonce } = extractMessageParams(option);

  const message = {
    from: fromAddress as `0x${string}`,
    to: option.payTo as `0x${string}`,
    value: BigInt(option.amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as `0x${string}`,
  };

  // Sign EIP-712 typed data via the user's wallet
  const signature = await account.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload: X402PaymentPayloadV2 = {
    x402Version: 2,
    resource,
    accepted: option,
    payload: {
      signature,
      authorization: {
        from: fromAddress,
        to: option.payTo,
        value: option.amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const json = JSON.stringify(payload);
  const headerValue = btoa(json);

  return {
    headerName: "PAYMENT-SIGNATURE",
    headerValue,
    x402Version: 2,
  };
}

async function buildSignedPayloadV1(
  account: Account,
  option: X402PaymentOption,
): Promise<SignedPayloadResult> {
  const fromAddress = account.address;

  const chainId = getChainId(option.network);
  if (chainId === null) {
    throw new Error(
      `Unsupported network for EIP-3009 signing: ${option.network}`,
    );
  }

  const domain = extractDomain(option, chainId);
  const { validAfter, validBefore, nonce } = extractMessageParams(option);

  const message = {
    from: fromAddress as `0x${string}`,
    to: option.payTo as `0x${string}`,
    value: BigInt(option.amount),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as `0x${string}`,
  };

  const signature = await account.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload: X402PaymentPayloadV1 = {
    x402Version: 1,
    scheme: option.scheme,
    network: option.network,
    payload: {
      signature,
      authorization: {
        from: fromAddress,
        to: option.payTo,
        value: option.amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const json = JSON.stringify(payload);
  const headerValue = btoa(json);

  return {
    headerName: "X-PAYMENT",
    headerValue,
    x402Version: 1,
  };
}
