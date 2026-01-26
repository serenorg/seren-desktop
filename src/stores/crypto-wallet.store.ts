// ABOUTME: Store for managing crypto wallet state for x402 USDC payments.
// ABOUTME: Handles wallet address, configuration status, and key operations via Tauri IPC.

import { createRoot, createSignal } from "solid-js";
import {
  clearCryptoWallet,
  getCryptoUsdcBalance,
  getCryptoWalletAddress,
  storeCryptoPrivateKey,
} from "@/lib/tauri-bridge";

interface CryptoWalletState {
  address: string | null;
  isConfigured: boolean;
  isLoading: boolean;
  error: string | null;
  usdcBalance: string | null;
  usdcBalanceRaw: string | null;
  balanceLoading: boolean;
}

function createCryptoWalletStore() {
  const [state, setState] = createSignal<CryptoWalletState>({
    address: null,
    isConfigured: false,
    isLoading: false,
    error: null,
    usdcBalance: null,
    usdcBalanceRaw: null,
    balanceLoading: false,
  });

  // Fetch USDC balance from Base mainnet
  const fetchBalance = async () => {
    const currentState = state();
    if (!currentState.isConfigured) return;

    setState((prev) => ({ ...prev, balanceLoading: true }));
    try {
      const balanceInfo = await getCryptoUsdcBalance();
      setState((prev) => ({
        ...prev,
        usdcBalance: balanceInfo.balance,
        usdcBalanceRaw: balanceInfo.balanceRaw,
        balanceLoading: false,
      }));
    } catch (err) {
      // Don't overwrite the main error, just log balance fetch failure
      console.error("Failed to fetch USDC balance:", err);
      setState((prev) => ({
        ...prev,
        balanceLoading: false,
      }));
    }
  };

  // Load wallet address on initialization
  const loadWallet = async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const address = await getCryptoWalletAddress();
      setState((prev) => ({
        ...prev,
        address,
        isConfigured: address !== null,
        isLoading: false,
        error: null,
      }));
      // Fetch balance if wallet is configured
      if (address !== null) {
        fetchBalance();
      }
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to load wallet",
      }));
    }
  };

  // Store a new private key
  const storeKey = async (privateKey: string): Promise<string> => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const address = await storeCryptoPrivateKey(privateKey);
      setState((prev) => ({
        ...prev,
        address,
        isConfigured: true,
        isLoading: false,
        error: null,
      }));
      // Fetch balance after storing key
      fetchBalance();
      return address;
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to store key";
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMsg,
      }));
      throw new Error(errorMsg);
    }
  };

  // Clear the wallet
  const clearWallet = async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      await clearCryptoWallet();
      setState({
        address: null,
        isConfigured: false,
        isLoading: false,
        error: null,
        usdcBalance: null,
        usdcBalanceRaw: null,
        balanceLoading: false,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to clear wallet",
      }));
    }
  };

  // Initialize on creation
  loadWallet();

  return {
    state,
    loadWallet,
    storeKey,
    clearWallet,
    fetchBalance,
  };
}

// Create singleton store
export const cryptoWalletStore = createRoot(createCryptoWalletStore);
