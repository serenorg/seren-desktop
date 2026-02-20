// ABOUTME: About Seren dialog showing detailed build information.
// ABOUTME: Triggered by the native "About Seren" menu item via Tauri event.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { updaterStore } from "@/stores/updater.store";

interface BuildInfo {
  app_version: string;
  release_tag: string;
  commit: string;
  build_date: string;
  build_type: string;
  tauri_version: string;
  webview: string;
  rust_version: string;
  os: string;
}

export function AboutDialog() {
  const [isOpen, setIsOpen] = createSignal(false);
  const [info, setInfo] = createSignal<BuildInfo | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [showUpToDate, setShowUpToDate] = createSignal(false);
  const [isCheckingManually, setIsCheckingManually] = createSignal(false);

  onMount(() => {
    const unlisten = listen("open-about", async () => {
      setIsOpen(true);
      try {
        const buildInfo = await invoke<BuildInfo>("get_build_info");
        setInfo(buildInfo);
      } catch (e) {
        console.error("[AboutDialog] Failed to get build info:", e);
      }
    });

    onCleanup(() => {
      unlisten.then((fn) => fn());
    });
  });

  function close() {
    setIsOpen(false);
    setCopied(false);
    setShowUpToDate(false);
    setIsCheckingManually(false);
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function copyInfo() {
    const data = info();
    if (!data) return;

    const text = [
      `Version: ${data.app_version}`,
      `Release: ${data.release_tag}`,
      `Commit: ${data.commit}`,
      `Date: ${data.build_date}`,
      `Build Type: ${data.build_type}`,
      `Tauri: ${data.tauri_version}`,
      `WebView: ${data.webview}`,
      `Rust: ${data.rust_version}`,
      `OS: ${data.os}`,
    ].join("\n");

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function checkForUpdates() {
    setIsCheckingManually(true);
    await updaterStore.checkForUpdates(true);
    setIsCheckingManually(false);

    if (updaterStore.state.status === "up_to_date") {
      setShowUpToDate(true);
    }
  }

  function closeUpToDate() {
    setShowUpToDate(false);
  }

  function installUpdate() {
    close();
    updaterStore.installAvailableUpdate();
  }

  return (
    <>
      <Show when={isOpen()}>
        <div
          class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_150ms_ease-out]"
          onClick={handleBackdropClick}
        >
          <div class="bg-popover border border-border rounded-xl w-[420px] max-w-[90vw] shadow-[var(--shadow-lg)] animate-[slideUp_200ms_ease-out] overflow-hidden">
            <div class="px-6 pt-6 pb-4 text-center">
              <h2 class="m-0 text-lg font-semibold text-foreground">Seren</h2>
            </div>
            <Show when={info()}>
              {(data) => (
                <div class="px-6 pb-4">
                  <Row label="Version" value={data().app_version} />
                  <Row label="Release" value={data().release_tag} />
                  <Row label="Commit" value={data().commit} />
                  <Row label="Date" value={data().build_date} />
                  <Row label="Build Type" value={data().build_type} />
                  <Row label="Tauri" value={data().tauri_version} />
                  <Row label="WebView" value={data().webview} />
                  <Row label="Rust" value={data().rust_version} />
                  <Row label="OS" value={data().os} />
                </div>
              )}
            </Show>
            <div class="flex gap-3 px-6 py-4 border-t border-border justify-end">
              <button
                type="button"
                class="px-5 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-border transition-colors duration-150 bg-card text-foreground hover:bg-accent"
                onClick={close}
              >
                OK
              </button>
              <Show
                when={
                  updaterStore.state.status !== "unsupported" &&
                  updaterStore.state.status !== "available"
                }
              >
                <button
                  type="button"
                  class="px-5 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-primary transition-colors duration-150 bg-primary text-white hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
                  onClick={checkForUpdates}
                  disabled={
                    isCheckingManually() ||
                    updaterStore.state.status === "checking"
                  }
                >
                  {isCheckingManually() ||
                  updaterStore.state.status === "checking"
                    ? "Checking..."
                    : "Check for Updates"}
                </button>
              </Show>
              <Show when={updaterStore.state.status === "available"}>
                <button
                  type="button"
                  class="px-5 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-success/70 transition-colors duration-150 bg-success/70 text-white hover:bg-success/85"
                  onClick={installUpdate}
                >
                  Install Update {updaterStore.state.availableVersion}
                </button>
              </Show>
              <button
                type="button"
                class="px-5 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-primary transition-colors duration-150 bg-primary text-white hover:opacity-90"
                onClick={copyInfo}
              >
                {copied() ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={showUpToDate()}>
        <div
          class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_150ms_ease-out]"
          onClick={closeUpToDate}
        >
          <div class="bg-popover border border-border rounded-xl w-[360px] max-w-[90vw] shadow-[var(--shadow-lg)] animate-[slideUp_200ms_ease-out] overflow-hidden">
            <div class="px-6 pt-6 pb-4 text-center">
              <h2 class="m-0 text-lg font-semibold text-foreground">
                All Up to Date!
              </h2>
            </div>
            <div class="px-6 pb-4 text-center">
              <p>You're running the latest version of Seren.</p>
            </div>
            <div class="flex gap-3 px-6 py-4 border-t border-border justify-end">
              <button
                type="button"
                class="px-5 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-border transition-colors duration-150 bg-card text-foreground hover:bg-accent"
                onClick={closeUpToDate}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div class="flex justify-between py-1.5 text-[13px] leading-normal">
      <span class="text-muted-foreground shrink-0 mr-4">{props.label}</span>
      <span class="text-foreground text-right break-all font-mono text-xs">
        {props.value}
      </span>
    </div>
  );
}
