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
import "./TransactionHistory.css";

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
    <div class="transaction-history">
      <header class="transaction-history-header">
        <h3>Transaction History</h3>
        <Show when={props.onClose}>
          <button
            class="transaction-history-close"
            onClick={props.onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </Show>
      </header>

      <div class="transaction-filters">
        <button
          class={`filter-btn ${filter() === "all" ? "active" : ""}`}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        <button
          class={`filter-btn ${filter() === "deposit" ? "active" : ""}`}
          onClick={() => setFilter("deposit")}
        >
          Deposits
        </button>
        <button
          class={`filter-btn ${filter() === "charge" ? "active" : ""}`}
          onClick={() => setFilter("charge")}
        >
          Charges
        </button>
      </div>

      <div class="transaction-list">
        <Show when={data.loading}>
          <div class="transaction-loading">
            <div class="transaction-spinner" />
            <span>Loading transactions...</span>
          </div>
        </Show>

        <Show when={data.error}>
          <div class="transaction-error">
            <span>Failed to load transactions</span>
            <button onClick={() => refetch()}>Retry</button>
          </div>
        </Show>

        <Show when={!data.loading && !data.error}>
          <Show
            when={filteredTransactions().length > 0}
            fallback={
              <div class="transaction-empty">
                <span>No transactions found</span>
              </div>
            }
          >
            <For each={filteredTransactions()}>
              {(transaction) => <TransactionItem transaction={transaction} />}
            </For>

            <Show when={hasMore()}>
              <button class="load-more-btn" onClick={handleLoadMore}>
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

  return (
    <div class={`transaction-item transaction-item--${category()}`}>
      <div class="transaction-icon">
        <span>{getTransactionIcon(props.transaction.source)}</span>
      </div>
      <div class="transaction-details">
        <span class="transaction-type">
          {getTransactionLabel(props.transaction.source)}
        </span>
        <span class="transaction-description">
          {props.transaction.description || props.transaction.source}
        </span>
        <span class="transaction-date">
          {formatDate(props.transaction.created_at)} at{" "}
          {formatTime(props.transaction.created_at)}
        </span>
      </div>
      <div class="transaction-amount-wrapper">
        <span
          class={`transaction-amount ${isPositive() ? "positive" : "negative"}`}
        >
          {isPositive() ? "+" : "-"}
          {props.transaction.amount_usd}
        </span>
        <span class="transaction-balance">
          Balance: {props.transaction.remaining_usd}
        </span>
      </div>
    </div>
  );
};
