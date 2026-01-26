// ABOUTME: Application header with title, balance, and user actions.
// ABOUTME: Displays app name, wallet balance, and sign-in/logout controls based on auth state.

import { Component, Show } from "solid-js";
import { BalanceDisplay } from "./BalanceDisplay";
import "./Header.css";

interface HeaderProps {
  onLogout?: () => void;
  onSignIn?: () => void;
  isAuthenticated?: boolean;
}

export const Header: Component<HeaderProps> = (props) => {
  return (
    <header class="header">
      <h1 class="header-title">Seren Desktop</h1>
      <div class="header-actions">
        <Show
          when={props.isAuthenticated}
          fallback={
            props.onSignIn && (
              <button type="button" class="header-signin" onClick={props.onSignIn}>
                Sign In
              </button>
            )
          }
        >
          <BalanceDisplay />
          {props.onLogout && (
            <button type="button" class="header-logout" onClick={props.onLogout}>
              Logout
            </button>
          )}
        </Show>
      </div>
    </header>
  );
};
