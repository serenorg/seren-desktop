// ABOUTME: About Seren dialog showing detailed build information.
// ABOUTME: Triggered by the native "About Seren" menu item via Tauri event.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import "./AboutDialog.css";

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

  onMount(() => {
    const unlisten = listen("open-about", async () => {
      try {
        const buildInfo = await invoke<BuildInfo>("get_build_info");
        setInfo(buildInfo);
      } catch (e) {
        console.error("[AboutDialog] Failed to get build info:", e);
      }
      setIsOpen(true);
    });

    onCleanup(() => {
      unlisten.then((fn) => fn());
    });
  });

  function close() {
    setIsOpen(false);
    setCopied(false);
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

  return (
    <Show when={isOpen()}>
      <div class="about-overlay" onClick={handleBackdropClick}>
        <div class="about-dialog">
          <div class="about-header">
            <h2>Seren</h2>
          </div>
          <Show when={info()}>
            {(data) => (
              <div class="about-content">
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
          <div class="about-footer">
            <button class="about-btn-ok" onClick={close}>
              OK
            </button>
            <button class="about-btn-copy" onClick={copyInfo}>
              {copied() ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div class="about-row">
      <span class="about-label">{props.label}</span>
      <span class="about-value">{props.value}</span>
    </div>
  );
}
