// ABOUTME: Application status bar at the bottom.
// ABOUTME: Displays status messages, wallet balance, MCP state, and connection state.

import { Component } from "solid-js";
import { McpStatusIndicator } from "./McpStatusIndicator";
import { WalletStatus } from "./WalletStatus";
import "./StatusBar.css";

interface StatusBarProps {
  message?: string;
}

export const StatusBar: Component<StatusBarProps> = (props) => {
  return (
    <footer class="status-bar">
      <span class="status-message">{props.message || "Ready"}</span>
      <div class="status-bar-right">
        <WalletStatus />
        <McpStatusIndicator />
      </div>
    </footer>
  );
};
