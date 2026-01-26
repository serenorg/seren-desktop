// ABOUTME: Store for managing crypto wallet state for x402 USDC payments.
// ABOUTME: Handles wallet address, configuration status, and key operations via Tauri IPC.

import { createSignal, createRoot } from "solid-js";
import {
  storeCryptoPrivateKey,
  getCryptoWalletAddress,
  clearCryptoWallet,
} from "@/lib/tauri-bridge";

interface CryptoWalletState {
  address: string | null;
  isConfigured: boolean;
  isLoading: boolean;
  error: string | null;
}

function createCryptoWalletStore() {
  const [state, setState] = createSignal<CryptoWalletState>({
    address: null,
    isConfigured: false,
    isLoading: false,
    error: null,
  });

  // Load wallet address on initialization
  const loadWallet = async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const address = await getCryptoWalletAddress();
      setState({
        address,
        isConfigured: address !== null,
        isLoading: false,
        error: null,
      });
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
      setState({
        address,
        isConfigured: true,
        isLoading: false,
        error: null,
      });
      return address;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to store key";
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
  };
}

// Create singleton store
export const cryptoWalletStore = createRoot(createCryptoWalletStore);
