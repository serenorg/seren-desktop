// ABOUTME: Transaction history component showing deposits, charges, and refunds.
// ABOUTME: Displays paginated list with filtering options.

import { Component, createSignal, createResource, For, Show } from "solid-js";
import {
  fetchTransactions,
  Transaction,
  TransactionType,
} from "@/services/wallet";
import "./TransactionHistory.css";

type FilterType = "all" | TransactionType;

interface TransactionHistoryProps {
  onClose?: () => void;
}

/**
 * Get icon for transaction type.
 */
function getTransactionIcon(type: TransactionType): string {
  switch (type) {
    case "deposit":
      return "&#x2B06;"; // Up arrow
    case "charge":
      return "&#x2B07;"; // Down arrow
    case "refund":
      return "&#x21A9;"; // Return arrow
    case "auto_topup":
      return "&#x26A1;"; // Lightning
    default:
      return "&#x2022;"; // Bullet
  }
}

/**
 * Get display label for transaction type.
 */
function getTransactionLabel(type: TransactionType): string {
  switch (type) {
    case "deposit":
      return "Deposit";
    case "charge":
      return "Charge";
    case "refund":
      return "Refund";
    case "auto_topup":
      return "Auto Top-Up";
    default:
      return type;
  }
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
export const TransactionHistory: Component<TransactionHistoryProps> = (props) => {
  const [filter, setFilter] = createSignal<FilterType>("all");
  const [cursor, setCursor] = createSignal<string | undefined>(undefined);

  const [data, { refetch }] = createResource(
    () => ({ filter: filter(), cursor: cursor() }),
    async () => {
      return fetchTransactions(20, cursor());
    }
  );

  const filteredTransactions = () => {
    const transactions = data()?.transactions ?? [];
    const currentFilter = filter();
    if (currentFilter === "all") return transactions;
    return transactions.filter((t) => t.type === currentFilter);
  };

  const handleLoadMore = () => {
    const nextCursor = data()?.nextCursor;
    if (nextCursor) {
      setCursor(nextCursor);
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
              {(transaction) => (
                <TransactionItem transaction={transaction} />
              )}
            </For>

            <Show when={data()?.hasMore}>
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
  const isPositive = () =>
    props.transaction.type === "deposit" ||
    props.transaction.type === "refund" ||
    props.transaction.type === "auto_topup";

  return (
    <div class={`transaction-item transaction-item--${props.transaction.type}`}>
      <div class="transaction-icon">
        <span innerHTML={getTransactionIcon(props.transaction.type)} />
      </div>
      <div class="transaction-details">
        <span class="transaction-type">
          {getTransactionLabel(props.transaction.type)}
        </span>
        <span class="transaction-description">
          {props.transaction.description}
        </span>
        <span class="transaction-date">
          {formatDate(props.transaction.createdAt)} at{" "}
          {formatTime(props.transaction.createdAt)}
        </span>
      </div>
      <div class="transaction-amount-wrapper">
        <span class={`transaction-amount ${isPositive() ? "positive" : "negative"}`}>
          {isPositive() ? "+" : "-"}${Math.abs(props.transaction.amount).toFixed(2)}
        </span>
        <Show when={props.transaction.balance !== undefined}>
          <span class="transaction-balance">
            Balance: ${props.transaction.balance?.toFixed(2)}
          </span>
        </Show>
      </div>
    </div>
  );
};
