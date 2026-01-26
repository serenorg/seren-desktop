// ABOUTME: Transaction history component showing deposits, charges, and refunds.
// ABOUTME: Displays paginated list with filtering options.

import {
  type Component,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { fetchTransactions, type Transaction } from "@/services/wallet";

/**
 * Source categories for filtering.
 */
type FilterType = "all" | "deposit" | "charge";

interface TransactionHistoryProps {
  onClose?: () => void;
}

/**
 * Infer transaction category from source string.
 */
function getTransactionCategory(
  source: string,
): "deposit" | "charge" | "refund" {
  const s = source.toLowerCase();
  if (
    s.includes("deposit") ||
    s.includes("stripe") ||
    s.includes("purchase") ||
    s.includes("topup")
  ) {
    return "deposit";
  }
  if (s.includes("refund")) {
    return "refund";
  }
  return "charge";
}

/**
 * Get icon for transaction source.
 */
function getTransactionIcon(source: string): string {
  const category = getTransactionCategory(source);
  switch (category) {
    case "deposit":
      return "⬆";
    case "refund":
      return "↩";
    default:
      return "⬇";
  }
}

/**
 * Get display label for transaction source.
 */
function getTransactionLabel(source: string): string {
  const category = getTransactionCategory(source);
  switch (category) {
    case "deposit":
      return "Deposit";
    case "refund":
      return "Refund";
    default:
      return "Charge";
  }
}

/**
 * Check if transaction is positive (adds to balance).
 */
function isPositiveTransaction(source: string): boolean {
  const category = getTransactionCategory(source);
  return category === "deposit" || category === "refund";
}

/**
 * Format date for display.
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format time for display.
 */
function formatTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Transaction history component.
 */
export const TransactionHistory: Component<TransactionHistoryProps> = (
  props,
) => {
  const [filter, setFilter] = createSignal<FilterType>("all");
  const [offset, setOffset] = createSignal(0);

  const [data, { refetch }] = createResource(
    () => ({ filter: filter(), offset: offset() }),
    async ({ offset: currentOffset }) => {
      return fetchTransactions(20, currentOffset);
    },
  );

  const filteredTransactions = () => {
    const transactions = data()?.transactions ?? [];
    const currentFilter = filter();
    if (currentFilter === "all") return transactions;
    return transactions.filter(
      (t) => getTransactionCategory(t.source) === currentFilter,
    );
  };

  const hasMore = () => {
    const response = data();
    if (!response) return false;
    return response.offset + response.transactions.length < response.total;
  };

  const handleLoadMore = () => {
    const response = data();
    if (response && hasMore()) {
      setOffset(response.offset + response.transactions.length);
    }
  };

  return (
    <div class="flex flex-col h-full max-h-[500px]">
      <header class="flex items-center justify-between px-5 py-4 border-b border-[rgba(148,163,184,0.15)]">
        <h3 class="text-[16px] font-semibold text-white m-0">
          Transaction History
        </h3>
        <Show when={props.onClose}>
          <button
            class="flex items-center justify-center w-7 h-7 p-0 bg-transparent border-none rounded text-[20px] text-[#94a3b8] cursor-pointer transition-all hover:bg-[rgba(148,163,184,0.1)] hover:text-white"
            onClick={props.onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </Show>
      </header>

      <div class="flex gap-2 px-5 py-3 border-b border-[rgba(148,163,184,0.15)]">
        <button
          class={`px-3 py-1.5 rounded-full text-[12px] font-medium cursor-pointer transition-all border ${
            filter() === "all"
              ? "bg-[#6366f1] border-[#6366f1] text-white"
              : "bg-[rgba(15,23,42,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.5)] hover:text-white"
          }`}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        <button
          class={`px-3 py-1.5 rounded-full text-[12px] font-medium cursor-pointer transition-all border ${
            filter() === "deposit"
              ? "bg-[#6366f1] border-[#6366f1] text-white"
              : "bg-[rgba(15,23,42,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.5)] hover:text-white"
          }`}
          onClick={() => setFilter("deposit")}
        >
          Deposits
        </button>
        <button
          class={`px-3 py-1.5 rounded-full text-[12px] font-medium cursor-pointer transition-all border ${
            filter() === "charge"
              ? "bg-[#6366f1] border-[#6366f1] text-white"
              : "bg-[rgba(15,23,42,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.5)] hover:text-white"
          }`}
          onClick={() => setFilter("charge")}
        >
          Charges
        </button>
      </div>

      <div class="flex-1 overflow-y-auto py-2">
        <Show when={data.loading}>
          <div class="flex flex-col items-center justify-center gap-3 px-5 py-10 text-[#64748b] text-[14px]">
            <div class="w-6 h-6 border-2 border-[rgba(148,163,184,0.15)] border-t-[#6366f1] rounded-full animate-spin" />
            <span>Loading transactions...</span>
          </div>
        </Show>

        <Show when={data.error}>
          <div class="flex flex-col items-center justify-center gap-3 px-5 py-10 text-[#64748b] text-[14px]">
            <span>Failed to load transactions</span>
            <button
              onClick={() => refetch()}
              class="px-3 py-1.5 bg-[#6366f1] border-none rounded text-[13px] text-white cursor-pointer"
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={!data.loading && !data.error}>
          <Show
            when={filteredTransactions().length > 0}
            fallback={
              <div class="flex flex-col items-center justify-center gap-3 px-5 py-10 text-[#64748b] text-[14px]">
                <span>No transactions found</span>
              </div>
            }
          >
            <For each={filteredTransactions()}>
              {(transaction) => <TransactionItem transaction={transaction} />}
            </For>

            <Show when={hasMore()}>
              <button
                class="block w-[calc(100%-40px)] mx-5 my-3 py-2.5 bg-[rgba(15,23,42,0.5)] border border-[rgba(148,163,184,0.15)] rounded-md text-[13px] font-medium text-[#94a3b8] cursor-pointer transition-all hover:bg-[rgba(30,41,59,0.5)] hover:text-white"
                onClick={handleLoadMore}
              >
                Load More
              </button>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
};

/**
 * Individual transaction item.
 */
const TransactionItem: Component<{ transaction: Transaction }> = (props) => {
  const category = () => getTransactionCategory(props.transaction.source);
  const isPositive = () => isPositiveTransaction(props.transaction.source);

  const getIconClasses = () => {
    const cat = category();
    if (cat === "deposit" || cat === "refund") {
      return "bg-[rgba(40,167,69,0.1)] text-[#28a745]";
    }
    return "bg-[rgba(108,117,125,0.1)] text-[#94a3b8]";
  };

  return (
    <div class="flex items-center gap-3 px-5 py-3 border-b border-[rgba(148,163,184,0.15)] transition-colors hover:bg-[rgba(148,163,184,0.05)] last:border-b-0">
      <div
        class={`flex items-center justify-center w-9 h-9 rounded-full text-[16px] shrink-0 ${getIconClasses()}`}
      >
        <span>{getTransactionIcon(props.transaction.source)}</span>
      </div>
      <div class="flex-1 min-w-0 flex flex-col gap-0.5">
        <span class="text-[14px] font-medium text-white">
          {getTransactionLabel(props.transaction.source)}
        </span>
        <span class="text-[12px] text-[#94a3b8] overflow-hidden text-ellipsis whitespace-nowrap">
          {props.transaction.description || props.transaction.source}
        </span>
        <span class="text-[11px] text-[#64748b]">
          {formatDate(props.transaction.created_at)} at{" "}
          {formatTime(props.transaction.created_at)}
        </span>
      </div>
      <div class="flex flex-col items-end gap-0.5 shrink-0">
        <span
          class={`text-[14px] font-semibold tabular-nums ${isPositive() ? "text-[#28a745]" : "text-[#94a3b8]"}`}
        >
          {isPositive() ? "+" : "-"}
          {props.transaction.amount_usd}
        </span>
        <span class="text-[11px] text-[#64748b] tabular-nums">
          Balance: {props.transaction.remaining_usd}
        </span>
      </div>
    </div>
  );
};
