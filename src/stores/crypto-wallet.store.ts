// ABOUTME: Store for managing crypto wallet state via Thirdweb.
// ABOUTME: Handles wallet connection, address tracking, and USDC balance queries.

import { createRoot, createSignal } from "solid-js";
import type { Account, Wallet, WalletId } from "thirdweb/wallets";
import { createWallet } from "thirdweb/wallets";
import { thirdwebClient } from "@/lib/thirdweb";
import { getUsdcBalance } from "@/lib/x402/balance";

interface CryptoWalletState {
  address: string | null;
  isConfigured: boolean;
  isLoading: boolean;
  error: string | null;
  usdcBalance: string | null;
  usdcBalanceRaw: string | null;
  balanceLoading: boolean;
}

// Module-level references to the connected wallet and account (not reactive)
let connectedWallet: Wallet | null = null;
let connectedAccount: Account | null = null;

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
    if (!currentState.isConfigured || !currentState.address) return;

    setState((prev) => ({ ...prev, balanceLoading: true }));
    try {
      const balanceInfo = await getUsdcBalance(currentState.address);
      setState((prev) => ({
        ...prev,
        usdcBalance: balanceInfo.balance,
        usdcBalanceRaw: balanceInfo.balanceRaw,
        balanceLoading: false,
      }));
    } catch (err) {
      console.error("Failed to fetch USDC balance:", err);
      setState((prev) => ({
        ...prev,
        balanceLoading: false,
      }));
    }
  };

  // Connect wallet via Thirdweb (opens wallet selection)
  const connectWallet = async (walletId: WalletId = "io.metamask") => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const wallet = createWallet(walletId);
      const account = await wallet.connect({ client: thirdwebClient });

      connectedWallet = wallet;
      connectedAccount = account;

      setState((prev) => ({
        ...prev,
        address: account.address,
        isConfigured: true,
        isLoading: false,
        error: null,
      }));

      fetchBalance();
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to connect wallet";
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMsg,
      }));
    }
  };

  // Disconnect the wallet
  const clearWallet = async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      if (connectedWallet) {
        await connectedWallet.disconnect();
      }
      connectedWallet = null;
      connectedAccount = null;

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
        error:
          err instanceof Error ? err.message : "Failed to disconnect wallet",
      }));
    }
  };

  // Get the connected Account for signing operations
  const getAccount = (): Account | null => connectedAccount;

  return {
    state,
    connectWallet,
    clearWallet,
    fetchBalance,
    getAccount,
  };
}

// Create singleton store
export const cryptoWalletStore = createRoot(createCryptoWalletStore);
