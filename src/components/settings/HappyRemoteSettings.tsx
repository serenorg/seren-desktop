// ABOUTME: Settings controls for the Happy remote access bridge.
// ABOUTME: Keeps pairing, connection state, and advertised project roots local to Settings.

import { confirm } from "@tauri-apps/plugin-dialog";
import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { openExternalLink } from "@/lib/external-link";
import { toDataURL } from "@/lib/qrcode-shim";
import { captureSupportError } from "@/lib/support/hook";
import { listConversations } from "@/lib/tauri-bridge";
import {
  cancelPairing,
  disableRemoteAccess,
  enableRemoteAccess,
  getAdvertisedRoots,
  getRemoteAccessStatus,
  type HappyRemoteStatus,
  onStatusChange,
  resetRemoteIdentity,
  startPairing,
  updateAdvertisedRoots,
} from "@/services/happyRemote";

const DESCRIPTION =
  "Use your phone to monitor and control agents running in Seren Desktop. Sessions are end-to-end encrypted and only reachable while this app is open.";
const RESET_COPY =
  "Unpair all phones? This deletes this machine's remote identity. You'll need to pair again from scratch.";
const HAPPY_WEBSITE_URL = "https://happy.engineering/";
const HAPPY_STORES = [
  {
    platform: "apple",
    url: "https://apps.apple.com/us/app/happy-claude-code-client/id6748571505",
    label: "Download Happy on the App Store",
    eyebrow: "Download on the",
    name: "App Store",
    score: "4.9",
    count: "970+ ratings",
  },
  {
    platform: "google",
    url: "https://play.google.com/store/apps/details?id=com.ex3ndr.happy",
    label: "Get Happy on Google Play",
    eyebrow: "Get it on",
    name: "Google Play",
    score: "4.8",
    count: "2.9k+ reviews",
  },
] as const;

const StoreMark: Component<{ platform: "apple" | "google" }> = (props) => (
  <Show
    when={props.platform === "apple"}
    fallback={
      <svg class="h-8 w-8 shrink-0" viewBox="0 0 32 36" aria-hidden="true">
        <path fill="#43c9f4" d="M3 3 19 18 3 33Z" />
        <path fill="#48d27a" d="M3 3 22 14 19 18Z" />
        <path fill="#ffd34e" d="m19 18 3-4 7 4-7 4Z" />
        <path fill="#ff5b5f" d="M3 33 19 18l3 4Z" />
      </svg>
    }
  >
    <svg
      class="h-8 w-8 shrink-0 fill-current"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M15.9 2.1c-.2 1.4-1.2 2.7-2.7 3-.2-1.4.8-2.8 2.7-3Zm3.1 11.2c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.6.9-.8 0-1.9-.9-3.1-.9-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3.1 2.4 1.2-.1 1.7-.8 3.3-.8 1.5 0 2 .8 3.3.8 1.4 0 2.3-1.2 3.1-2.4 1-1.4 1.4-2.8 1.4-2.9-.1 0-3.3-1.3-3.3-3.7Z" />
    </svg>
  </Show>
);

function uniqueRoots(
  rows: Awaited<ReturnType<typeof listConversations>>,
): string[] {
  const roots: string[] = [];
  for (const row of rows) {
    const root = row.project_root ?? row.agent_cwd;
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function statusLabel(status: HappyRemoteStatus): string {
  // A restart is reported as `starting` with a "restart attempt N/M" detail, so
  // the check has to come before the state switch. Nested under `error` it was
  // unreachable, and a crash-looping bridge read as "Connecting…" until the
  // budget ran out.
  if (status.detail?.startsWith("restart attempt")) {
    return `Offline — retrying (${status.detail.replace("restart attempt ", "")})`;
  }
  switch (status.state) {
    case "starting":
      return "Connecting…";
    case "running":
      return "Connected";
    case "error":
      return `Error: ${status.detail ?? "bridge unavailable"}`;
    default:
      return "Off";
  }
}

export const HappyRemoteSettings: Component = () => {
  const [status, setStatus] = createSignal<HappyRemoteStatus>({
    state: "stopped",
  });
  const [roots, setRoots] = createSignal<string[]>([]);
  const [advertisedRoots, setAdvertisedRoots] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);
  const [pairingPayload, setPairingPayload] = createSignal<string | null>(null);
  const [pairingQr, setPairingQr] = createSignal<string | null>(null);
  const [pairingError, setPairingError] = createSignal(false);
  let unlistenStatus: (() => void) | undefined;
  let unmounted = false;

  const loadRoots = async () => {
    try {
      const [rows, saved] = await Promise.all([
        listConversations({ kind: "agent" }),
        getAdvertisedRoots(),
      ]);
      const discovered = uniqueRoots(rows);
      setRoots(discovered);
      setAdvertisedRoots(
        saved === null ? [] : saved.filter((root) => discovered.includes(root)),
      );
    } catch {
      setMessage("Could not load available project folders.");
    }
  };

  const refreshStatus = async () => {
    try {
      setStatus(await getRemoteAccessStatus());
    } catch {
      setStatus({ state: "error", detail: "status unavailable" });
    }
  };

  onMount(() => {
    void refreshStatus();
    void loadRoots();
    void onStatusChange((next) => {
      setStatus(next);
      if (next.state === "error") {
        void captureSupportError({
          kind: "HappyBridgeError",
          message: next.detail ?? "Happy bridge stopped unexpectedly",
        });
      }
    }).then((unlisten) => {
      // The listener resolves after a round trip, so a section switch can land
      // first. Dropping the handle there leaked one listener per mount, each
      // still reporting every bridge error.
      if (unmounted) {
        unlisten();
        return;
      }
      unlistenStatus = unlisten;
    });
  });

  // Switching settings sections unmounts this component without going through
  // the dismiss button, and the bridge kept the scanned code authorizable for
  // the rest of its timeout. Unmounting has to withdraw the code too.
  onCleanup(() => {
    unmounted = true;
    unlistenStatus?.();
    if (pairingPayload() !== null) {
      void cancelPairing().catch(() => undefined);
    }
  });

  const toggleRemoteAccess = async (enabled: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = enabled
        ? await enableRemoteAccess()
        : await disableRemoteAccess();
      setStatus(next);
    } catch {
      setMessage(`Could not ${enabled ? "enable" : "disable"} remote access.`);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const pairPhone = async () => {
    setBusy(true);
    setMessage(null);
    setPairingError(false);
    try {
      const payload = await startPairing();
      setPairingPayload(payload);
      setPairingQr(await toDataURL(payload, { margin: 1, width: 280 }));
      await refreshStatus();
    } catch {
      setPairingPayload(null);
      setPairingQr(null);
      setPairingError(true);
      setMessage("Could not create a pairing code.");
    } finally {
      setBusy(false);
    }
  };

  // Dismissing the dialog has to tell the bridge to stop waiting. Clearing the
  // local signals alone left the pairing window open for its full timeout,
  // still ready to accept whoever scanned the code.
  const dismissPairing = async () => {
    setPairingPayload(null);
    setPairingQr(null);
    try {
      await cancelPairing();
    } catch {
      setMessage(
        "Could not cancel pairing. Turn remote access off to be sure.",
      );
    }
    await refreshStatus();
  };

  const toggleRoot = async (root: string, included: boolean) => {
    const previous = advertisedRoots();
    const next = included
      ? [...previous, root]
      : previous.filter((candidate) => candidate !== root);
    setAdvertisedRoots(next);
    setMessage(null);
    try {
      const nextStatus = await updateAdvertisedRoots(next);
      setStatus(nextStatus);
    } catch {
      setAdvertisedRoots(previous);
      setMessage("Could not update available project folders.");
    }
  };

  const unpair = async () => {
    const confirmed = await confirm(RESET_COPY, {
      title: "Reset Happy remote access",
      kind: "warning",
    });
    if (!confirmed) return;
    setBusy(true);
    setMessage(null);
    try {
      await resetRemoteIdentity();
      setStatus(await disableRemoteAccess());
      setPairingPayload(null);
      setPairingQr(null);
    } catch {
      setMessage("Could not reset remote access.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div class="flex items-start justify-between gap-4 mb-2">
        <div>
          <h3 class="m-0 text-[1.3rem] font-semibold">Remote access</h3>
          <p class="m-0 mt-2 text-muted-foreground leading-normal">
            {DESCRIPTION}
          </p>
        </div>
        <Show when={status().state === "running"}>
          <button
            type="button"
            class="text-muted-foreground text-base leading-none bg-transparent border-none cursor-pointer"
            title="Remote access active — click to disconnect."
            aria-label="Remote access active — click to disconnect."
            onClick={() => void toggleRemoteAccess(false)}
            disabled={busy()}
          >
            ●
          </button>
        </Show>
      </div>

      <div class="my-5 rounded-xl border border-border-strong bg-surface-2/70 p-4">
        <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div class="max-w-[620px]">
            <p class="m-0 text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-accent">
              Install the mobile app
            </p>
            <h4 class="m-0 mt-1 text-base font-semibold text-foreground">
              Get Happy on your phone
            </h4>
            <p class="m-0 mt-1 text-[0.82rem] leading-normal text-muted-foreground">
              Happy is the free, open-source mobile remote control for coding
              agents running in Seren Desktop. Install it, then pair this
              computer by scanning the QR code below.
            </p>
          </div>
          <a
            href={HAPPY_WEBSITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="shrink-0 rounded text-[0.8rem] font-medium text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label="Learn more about Happy (opens in your browser)"
            onClick={(event) => {
              event.preventDefault();
              void openExternalLink(HAPPY_WEBSITE_URL);
            }}
          >
            Learn more about Happy ↗
          </a>
        </div>

        <div class="mt-4 flex flex-wrap gap-x-5 gap-y-4">
          <For each={HAPPY_STORES}>
            {(store) => (
              <div class="flex flex-col gap-1.5">
                <a
                  href={store.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="group flex h-[54px] w-[180px] items-center gap-2.5 rounded-xl border border-white/20 bg-black px-3.5 text-white shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                  aria-label={`${store.label} (opens in your browser)`}
                  onClick={(event) => {
                    event.preventDefault();
                    void openExternalLink(store.url);
                  }}
                >
                  <StoreMark platform={store.platform} />
                  <span class="flex min-w-0 flex-col leading-none">
                    <span class="text-[0.58rem] font-medium uppercase tracking-[0.04em] text-white/90">
                      {store.eyebrow}
                    </span>
                    <span class="mt-1 whitespace-nowrap text-[1.03rem] font-semibold tracking-[-0.02em]">
                      {store.name}
                    </span>
                  </span>
                </a>
                <p
                  class="m-0 flex items-baseline gap-1.5 pl-0.5 text-[0.74rem] text-muted-foreground"
                  aria-label={`${store.score} out of 5 stars, ${store.count}`}
                >
                  <span
                    class="text-[0.7rem] tracking-[0.03em] text-[#f3b849]"
                    aria-hidden="true"
                  >
                    ★★★★★
                  </span>
                  <strong class="text-[0.8rem] font-semibold text-foreground">
                    {store.score}
                  </strong>
                  <span>{store.count}</span>
                </p>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="flex items-start justify-between gap-4 py-3 border-b border-border">
        <label class="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={status().state !== "stopped"}
            disabled={busy()}
            onChange={(event) =>
              void toggleRemoteAccess(event.currentTarget.checked)
            }
            class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
          />
          <span class="flex flex-col gap-0.5">
            <span class="text-[0.95rem] font-medium text-foreground">
              Remote access via Happy
            </span>
            <span class="text-[0.8rem] text-muted-foreground">
              Enable the local bridge while Seren Desktop is open
            </span>
          </span>
        </label>
        <span class="text-[0.85rem] text-muted-foreground text-right">
          {statusLabel(status())}
        </span>
      </div>

      <div class="flex items-center justify-between gap-4 py-3 border-b border-border">
        <span class="flex flex-col gap-0.5">
          <span class="text-[0.95rem] font-medium text-foreground">
            Pair a phone
          </span>
          <span class="text-[0.8rem] text-muted-foreground">
            {status().state === "running"
              ? "This device is already paired. Reset the pairing first to pair a different phone."
              : "Scan a one-time pairing code in the Happy mobile app"}
          </span>
        </span>
        <button
          type="button"
          class="px-4 py-1.5 border border-border-strong rounded-md bg-transparent text-foreground text-[0.85rem] cursor-pointer hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void pairPhone()}
          // A paired bridge never re-enters the pairing path, so the request
          // would stall for the full payload timeout and then error. Re-pairing
          // also mints a new machineId and replaces the stored identity, which
          // would orphan the existing pairing rather than add a second device.
          disabled={busy() || status().state === "running"}
        >
          Pair a phone
        </button>
      </div>

      <h4 class="mt-6 mb-3 text-base font-semibold text-muted-foreground border-t border-border-medium pt-5">
        Folders available for remote sessions
      </h4>
      <Show
        when={roots().length > 0}
        fallback={
          <p class="m-0 py-3 text-[0.8rem] text-muted-foreground">
            No recent project folders are available.
          </p>
        }
      >
        <div class="flex flex-col">
          <For each={roots()}>
            {(root) => (
              <label class="flex items-start gap-3 py-3 border-b border-border cursor-pointer">
                <input
                  type="checkbox"
                  checked={advertisedRoots().includes(root)}
                  onChange={(event) =>
                    void toggleRoot(root, event.currentTarget.checked)
                  }
                  class="w-[18px] h-[18px] mt-0.5 accent-accent cursor-pointer"
                />
                <span class="text-[0.85rem] text-foreground break-all">
                  {root}
                </span>
              </label>
            )}
          </For>
        </div>
      </Show>

      <div class="flex items-center justify-between gap-4 py-4 border-b border-border">
        <span class="flex flex-col gap-0.5">
          <span class="text-[0.95rem] font-medium text-foreground">
            Unpair and reset
          </span>
          <span class="text-[0.8rem] text-muted-foreground">
            Remove this machine's remote identity and disable remote access
          </span>
        </span>
        <button
          type="button"
          class="px-3 py-1.5 border border-destructive/60 bg-transparent rounded-md text-destructive text-[0.8rem] cursor-pointer hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void unpair()}
          disabled={busy()}
        >
          Unpair and reset
        </button>
      </div>

      <Show when={message()}>
        <p class="m-0 mt-3 text-[0.8rem] text-muted-foreground">{message()}</p>
      </Show>

      <Show when={pairingPayload()}>
        {(payload) => (
          <div
            class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]"
            onClick={() => void dismissPairing()}
          >
            <div
              class="bg-popover border border-border-strong rounded-xl p-6 max-w-[420px] w-[90%]"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 class="m-0 mb-2 text-[1.1rem]">Pair a phone</h3>
              <p class="m-0 mb-4 text-[0.85rem] text-muted-foreground">
                Scan this code from the Happy mobile app.
              </p>
              <Show
                when={pairingQr()}
                fallback={
                  <div>
                    <p class="m-0 mb-2 text-[0.8rem] text-muted-foreground">
                      The QR image could not be rendered. Copy this pairing
                      payload into a compatible scanner.
                    </p>
                    <textarea
                      class="w-full min-h-[100px] p-2 bg-surface-3 border border-border-strong rounded-md text-[0.75rem] text-foreground"
                      readonly
                      value={payload()}
                    />
                  </div>
                }
              >
                {(qr) => (
                  <div class="flex justify-center bg-white p-4">
                    <img src={qr()} alt="Happy pairing QR code" />
                  </div>
                )}
              </Show>
              <button
                type="button"
                class="mt-4 w-full px-4 py-2 bg-transparent border border-border-strong rounded-md text-muted-foreground text-[0.9rem] cursor-pointer hover:bg-border"
                onClick={() => void dismissPairing()}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={pairingError()}>
        <span class="sr-only">Pairing unavailable</span>
      </Show>
    </section>
  );
};
