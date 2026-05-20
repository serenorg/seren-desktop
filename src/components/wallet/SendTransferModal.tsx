// ABOUTME: Modal for sending SerenBucks to another user's email.
// ABOUTME: Previews transfer settlement before executing with an idempotency key.

import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  fetchTransfers,
  previewTransfer,
  recallTransfer,
  sendTransfer,
  type WalletTransferExecuteResponse,
  type WalletTransferListItem,
  type WalletTransferPreviewResponse,
} from "@/services/wallet";
import { refreshBalance, walletStore } from "@/stores/wallet.store";

interface SendTransferModalProps {
  onClose: () => void;
}

const toAmountCents = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
};

const formatCents = (amountCents?: number | null): string => {
  if (amountCents === undefined || amountCents === null) return "$0.00";
  return `$${(amountCents / 100).toFixed(2)}`;
};

const transferKey = (): string => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `transfer-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
};

export const SendTransferModal: Component<SendTransferModalProps> = (props) => {
  const [recipientEmail, setRecipientEmail] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [memo, setMemo] = createSignal("");
  const [preview, setPreview] =
    createSignal<WalletTransferPreviewResponse | null>(null);
  const [result, setResult] =
    createSignal<WalletTransferExecuteResponse | null>(null);
  const [pendingTransfers, setPendingTransfers] = createSignal<
    WalletTransferListItem[]
  >([]);
  const [idempotencyKey, setIdempotencyKey] = createSignal<string | null>(null);
  const [isPreviewing, setIsPreviewing] = createSignal(false);
  const [isSending, setIsSending] = createSignal(false);
  const [isLoadingPending, setIsLoadingPending] = createSignal(false);
  const [pendingLoadFailed, setPendingLoadFailed] = createSignal(false);
  const [recallingTransferId, setRecallingTransferId] = createSignal<
    string | null
  >(null);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  const amountCents = () => toAmountCents(amount());
  const canPreview = () =>
    recipientEmail().trim().length > 0 &&
    amountCents() !== null &&
    (amountCents() ?? 0) >= 100 &&
    (amountCents() ?? 0) <= 30000;

  const loadPendingTransfers = async () => {
    setIsLoadingPending(true);
    setPendingLoadFailed(false);
    try {
      const response = await fetchTransfers({
        direction: "sent",
        status: "pending",
        limit: 5,
      });
      setPendingTransfers(response.items);
    } catch {
      setPendingTransfers([]);
      setPendingLoadFailed(true);
    } finally {
      setIsLoadingPending(false);
    }
  };

  onMount(() => {
    void loadPendingTransfers();
  });

  const resetPreview = () => {
    setPreview(null);
    setResult(null);
    setCopied(false);
    setIdempotencyKey(null);
  };

  const handlePreview = async (event: Event) => {
    event.preventDefault();
    setError(null);
    setResult(null);

    const cents = amountCents();
    if (!canPreview() || cents === null) {
      setError("Enter a recipient email and an amount from $1.00 to $300.00.");
      return;
    }

    setIsPreviewing(true);
    try {
      const response = await previewTransfer(
        recipientEmail().trim(),
        cents,
        memo().trim() || null,
      );
      setPreview(response);
      setIdempotencyKey((existing) => existing ?? transferKey());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview send.");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleSend = async () => {
    const cents = amountCents();
    if (isSending() || !preview() || cents === null) return;

    const currentIdempotencyKey = idempotencyKey() ?? transferKey();
    setIdempotencyKey(currentIdempotencyKey);
    setIsSending(true);
    setError(null);
    try {
      const response = await sendTransfer(
        recipientEmail().trim(),
        cents,
        currentIdempotencyKey,
        memo().trim() || null,
      );
      setResult(response);
      setPreview(null);
      setIdempotencyKey(transferKey());
      await refreshBalance();
      await loadPendingTransfers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send.");
    } finally {
      setIsSending(false);
    }
  };

  const handleRecall = async (pendingTransferId: string) => {
    if (recallingTransferId()) return;

    setError(null);
    setRecallingTransferId(pendingTransferId);
    try {
      await recallTransfer(pendingTransferId);
      await refreshBalance();
      await loadPendingTransfers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to recall invite.");
    } finally {
      setRecallingTransferId(null);
    }
  };

  const copyInviteLink = async () => {
    const transfer = result();
    if (
      !transfer ||
      transfer.kind !== "pending_invite" ||
      !transfer.invite_url
    ) {
      return;
    }
    try {
      await navigator.clipboard.writeText(transfer.invite_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Failed to copy invite link.");
    }
  };

  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      props.onClose();
    }
  };

  return (
    <Portal>
      <div
        class="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 px-4 py-6"
        onClick={handleBackdropClick}
      >
        <div
          class="max-h-[min(90vh,760px)] w-full max-w-[520px] overflow-y-auto rounded-xl border border-border-medium bg-surface-2 shadow-[var(--shadow-lg)]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="send-transfer-title"
        >
          <header class="flex items-center justify-between border-b border-border-medium px-6 py-5">
            <div>
              <h2
                id="send-transfer-title"
                class="m-0 text-[18px] font-semibold text-white"
              >
                Send SerenBucks
              </h2>
              <p class="m-0 mt-1 text-[13px] text-muted-foreground">
                Current balance: {walletStore.formattedBalance}
              </p>
            </div>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-md border-0 bg-transparent p-0 text-[24px] text-muted-foreground transition-colors hover:bg-border hover:text-white"
              onClick={props.onClose}
              aria-label="Close"
            >
              &times;
            </button>
          </header>

          <div class="flex flex-col gap-5 p-6">
            <Show when={error()}>
              <div class="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                {error()}
              </div>
            </Show>

            <Show when={result()}>
              {(sent) => {
                const sentTransfer = sent();
                return (
                  <div class="rounded-lg border border-success/40 bg-success/10 p-4">
                    <h3 class="m-0 text-[15px] font-semibold text-success">
                      {sentTransfer.kind === "instant"
                        ? "Transfer sent"
                        : "Invite created"}
                    </h3>
                    <p class="m-0 mt-1 text-[13px] text-foreground">
                      Balance after send:{" "}
                      {formatCents(sentTransfer.balance_after_cents)}
                    </p>
                    <Show when={sentTransfer.kind === "pending_invite"}>
                      <div class="mt-3 flex gap-2">
                        <input
                          readOnly
                          value={
                            sentTransfer.kind === "pending_invite"
                              ? sentTransfer.invite_url || ""
                              : ""
                          }
                          class="min-w-0 flex-1 rounded-md border border-border-medium bg-background/50 px-3 py-2 text-[12px] text-foreground"
                        />
                        <button
                          type="button"
                          class="rounded-md border border-border-medium bg-background/50 px-3 py-2 text-[13px] text-foreground transition-colors hover:bg-surface-1"
                          onClick={copyInviteLink}
                        >
                          {copied() ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </Show>

            <form class="flex flex-col gap-4" onSubmit={handlePreview}>
              <div class="flex flex-col gap-2">
                <label
                  for="transfer-recipient-email"
                  class="text-[14px] font-medium text-white"
                >
                  Recipient Email
                </label>
                <input
                  id="transfer-recipient-email"
                  type="email"
                  value={recipientEmail()}
                  onInput={(event) => {
                    setRecipientEmail(event.currentTarget.value);
                    resetPreview();
                  }}
                  class="rounded-lg border border-border-medium bg-background/50 px-4 py-3 text-[15px] text-white outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                  placeholder="name@example.com"
                />
              </div>

              <div class="grid grid-cols-1 gap-4 sm:grid-cols-[160px_1fr]">
                <div class="flex flex-col gap-2">
                  <label
                    for="transfer-amount"
                    class="text-[14px] font-medium text-white"
                  >
                    Amount
                  </label>
                  <div class="flex items-center rounded-lg border border-border-medium bg-background/50 px-3 focus-within:border-primary">
                    <span class="text-muted-foreground">$</span>
                    <input
                      id="transfer-amount"
                      type="text"
                      inputMode="decimal"
                      value={amount()}
                      onInput={(event) => {
                        setAmount(event.currentTarget.value);
                        resetPreview();
                      }}
                      class="min-w-0 flex-1 border-0 bg-transparent px-2 py-3 text-[15px] text-white outline-none"
                      placeholder="25.00"
                    />
                  </div>
                </div>
                <div class="flex flex-col gap-2">
                  <label
                    for="transfer-memo"
                    class="text-[14px] font-medium text-white"
                  >
                    Memo
                  </label>
                  <input
                    id="transfer-memo"
                    value={memo()}
                    maxLength={140}
                    onInput={(event) => {
                      setMemo(event.currentTarget.value);
                      resetPreview();
                    }}
                    class="rounded-lg border border-border-medium bg-background/50 px-4 py-3 text-[15px] text-white outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                    placeholder="Optional"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={!canPreview() || isPreviewing()}
                class="rounded-lg bg-primary px-4 py-3 text-[14px] font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPreviewing() ? "Checking..." : "Preview Send"}
              </button>
            </form>

            <Show when={preview()}>
              {(currentPreview) => {
                const transferPreview = currentPreview();
                return (
                  <div class="rounded-lg border border-border-medium bg-background/50 p-4">
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <div class="text-[12px] uppercase tracking-wide text-muted-foreground">
                          Preview
                        </div>
                        <div class="mt-1 text-[15px] font-medium text-white">
                          {transferPreview.kind === "instant"
                            ? `Send to ${transferPreview.recipient.display_name}`
                            : `Create invite for ${transferPreview.recipient_email}`}
                        </div>
                        <div class="mt-1 text-[13px] text-muted-foreground">
                          Balance after send:{" "}
                          {formatCents(transferPreview.balance_after_cents)}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={isSending()}
                        class="rounded-lg bg-primary px-4 py-2 text-[14px] font-semibold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={handleSend}
                      >
                        {isSending() ? "Sending..." : "Send"}
                      </button>
                    </div>
                  </div>
                );
              }}
            </Show>

            <div class="border-t border-border-medium pt-4">
              <div class="mb-3 flex items-center justify-between">
                <h3 class="m-0 text-[14px] font-semibold text-white">
                  Pending Invites
                </h3>
                <button
                  type="button"
                  class="text-[12px] text-muted-foreground transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={loadPendingTransfers}
                  disabled={isLoadingPending()}
                >
                  {isLoadingPending() ? "Loading..." : "Refresh"}
                </button>
              </div>
              <Show
                when={pendingTransfers().length > 0}
                fallback={
                  <p class="m-0 text-[13px] text-muted-foreground">
                    {isLoadingPending()
                      ? "Loading pending invites..."
                      : pendingLoadFailed()
                        ? "Pending invites could not be loaded."
                        : "No pending invites."}
                  </p>
                }
              >
                <div class="flex flex-col gap-2">
                  <For each={pendingTransfers()}>
                    {(transfer) => (
                      <div class="flex items-center justify-between gap-3 rounded-lg border border-border-medium bg-background/50 px-3 py-2">
                        <div class="min-w-0">
                          <div class="truncate text-[13px] font-medium text-white">
                            {transfer.counterparty}
                          </div>
                          <div class="text-[12px] text-muted-foreground">
                            {transfer.amount_usd}
                          </div>
                        </div>
                        <button
                          type="button"
                          class="rounded-md border border-border-medium px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => handleRecall(transfer.id)}
                          disabled={recallingTransferId() === transfer.id}
                        >
                          {recallingTransferId() === transfer.id
                            ? "Recalling..."
                            : "Recall"}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
};
