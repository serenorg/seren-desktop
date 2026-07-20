// ABOUTME: Settings controls for the Happy remote access bridge.
// ABOUTME: Keeps pairing, connection state, and advertised project roots local to Settings.

import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { toDataURL } from "@/lib/qrcode-shim";
import { captureSupportError } from "@/lib/support/hook";
import { listConversations } from "@/lib/tauri-bridge";
import {
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
  "Control your agents from the Happy mobile app. End-to-end encrypted; sessions are only reachable while Seren Desktop is open.";
const RESET_COPY =
  "Unpair all phones? This deletes this machine's remote identity. You'll need to pair again from scratch.";

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
      unlistenStatus = unlisten;
    });
  });

  onCleanup(() => unlistenStatus?.());

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
    if (!window.confirm(RESET_COPY)) return;
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
            Scan a one-time pairing code in the Happy mobile app
          </span>
        </span>
        <button
          type="button"
          class="px-4 py-1.5 border border-border-strong rounded-md bg-transparent text-foreground text-[0.85rem] cursor-pointer hover:bg-border disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => void pairPhone()}
          disabled={busy()}
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
            onClick={() => {
              setPairingPayload(null);
              setPairingQr(null);
            }}
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
                onClick={() => {
                  setPairingPayload(null);
                  setPairingQr(null);
                }}
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
