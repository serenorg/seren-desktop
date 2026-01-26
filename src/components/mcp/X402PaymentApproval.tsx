// ABOUTME: Modal dialog for approving x402 USDC payments to MCP servers.
// ABOUTME: Shows payment details and allows user to approve or decline.

import { Show, type Component } from "solid-js";
import { x402Service } from "@/services/x402";
import "./X402PaymentApproval.css";

export const X402PaymentApproval: Component = () => {
  const payment = () => x402Service.pendingPayment();
  const isProcessing = () => x402Service.isProcessing();

  const handleApprove = () => {
    x402Service.approvePendingPayment();
  };

  const handleDecline = () => {
    x402Service.declinePendingPayment();
  };

  const formatAddress = (address: string): string => {
    if (address.length <= 16) return address;
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
  };

  return (
    <Show when={payment()}>
      {(p) => (
        <div class="x402-modal-overlay">
          <div class="x402-modal">
            <div class="x402-modal-header">
              <span class="x402-icon">💳</span>
              <h3>Payment Required</h3>
            </div>

            <div class="x402-modal-body">
              <p class="x402-description">
                The tool <strong>{p().toolName}</strong> on <strong>{p().serverName}</strong> requires a USDC payment to proceed.
              </p>

              <div class="x402-details">
                <div class="x402-detail-row">
                  <span class="x402-label">Amount</span>
                  <span class="x402-value x402-amount">{p().amountFormatted} USDC</span>
                </div>
                <div class="x402-detail-row">
                  <span class="x402-label">Network</span>
                  <span class="x402-value">{p().chainName}</span>
                </div>
                <div class="x402-detail-row">
                  <span class="x402-label">Recipient</span>
                  <span class="x402-value x402-address" title={p().recipient}>
                    {formatAddress(p().recipient)}
                  </span>
                </div>
              </div>

              <p class="x402-warning">
                This payment will be signed with your configured crypto wallet and sent to the network.
              </p>
            </div>

            <div class="x402-modal-actions">
              <button
                type="button"
                class="x402-btn x402-btn-secondary"
                onClick={handleDecline}
                disabled={isProcessing()}
              >
                Decline
              </button>
              <button
                type="button"
                class="x402-btn x402-btn-primary"
                onClick={handleApprove}
                disabled={isProcessing()}
              >
                {isProcessing() ? "Processing..." : "Approve Payment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default X402PaymentApproval;
