// ABOUTME: Application header with title and user actions.
// ABOUTME: Displays app name and provides access to user menu.

import { Component } from "solid-js";
import "./Header.css";

interface HeaderProps {
  onLogout?: () => void;
}

export const Header: Component<HeaderProps> = (props) => {
  return (
    <header class="header">
      <h1 class="header-title">Seren Desktop</h1>
      <div class="header-actions">
        {props.onLogout && (
          <button class="header-logout" onClick={props.onLogout}>
            Logout
          </button>
        )}
      </div>
    </header>
  );
};
