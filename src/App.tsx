// ABOUTME: Main application component with layout and auth integration.
// ABOUTME: Shows SignIn when not authenticated, main app when authenticated.

import { createSignal, Match, onMount, Show, Switch } from "solid-js";
import { Header } from "@/components/common/Header";
import { Sidebar, Panel } from "@/components/common/Sidebar";
import { StatusBar } from "@/components/common/StatusBar";
import { SignIn } from "@/components/auth/SignIn";
import { ChatPanel } from "@/components/chat/ChatPanel";
import {
  authStore,
  checkAuth,
  logout,
  setAuthenticated,
} from "@/stores/auth.store";
import "./App.css";

function App() {
  const [activePanel, setActivePanel] = createSignal<Panel>("chat");

  onMount(() => {
    checkAuth();
  });

  const handleLoginSuccess = () => {
    setAuthenticated({ id: "", email: "", name: "" });
  };

  const handleLogout = async () => {
    await logout();
  };

  return (
    <Show
      when={!authStore.isLoading}
      fallback={
        <div class="app-loading">
          <div class="loading-spinner" />
          <p>Loading...</p>
        </div>
      }
    >
      <Show when={authStore.isAuthenticated} fallback={<SignIn onSuccess={handleLoginSuccess} />}>
        <div class="app">
          <Header onLogout={handleLogout} />
          <div class="app-body">
            <Sidebar activePanel={activePanel()} onPanelChange={setActivePanel} />
            <main class="app-main">
              <Switch fallback={<div class="panel-placeholder">Select a panel</div>}>
                <Match when={activePanel() === "chat"}>
                  <ChatPanel />
                </Match>
                <Match when={activePanel() === "editor"}>
                  <div class="panel-placeholder">Editor Panel (Coming Soon)</div>
                </Match>
                <Match when={activePanel() === "catalog"}>
                  <div class="panel-placeholder">Catalog Panel (Coming Soon)</div>
                </Match>
                <Match when={activePanel() === "settings"}>
                  <div class="panel-placeholder">Settings Panel (Coming Soon)</div>
                </Match>
              </Switch>
            </main>
          </div>
          <StatusBar />
        </div>
      </Show>
    </Show>
  );
}

export default App;
