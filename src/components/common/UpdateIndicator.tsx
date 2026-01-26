import { Match, Show, Switch } from "solid-js";
import { updaterStore } from "@/stores/updater.store";

export const UpdateIndicator = () => {
  const state = () => updaterStore.state;

  return (
    <div
      class="update-indicator flex items-center gap-2 text-xs text-white"
      data-status={state().status}
    >
      <Switch
        fallback={
          <IdleIndicator onCheck={() => updaterStore.checkForUpdates(true)} />
        }
      >
        <Match when={state().status === "checking"}>
          <span class="inline-flex items-center gap-1 bg-white/15 py-0.5 px-2 rounded-full">
            Checking for updates…
          </span>
        </Match>
        <Match when={state().status === "up_to_date"}>
          <IdleIndicator onCheck={() => updaterStore.checkForUpdates(true)} />
        </Match>
        <Match when={state().status === "available"}>
          <AvailableIndicator
            version={state().availableVersion}
            error={state().error || undefined}
            onInstall={updaterStore.installAvailableUpdate}
            onDefer={updaterStore.deferUpdate}
          />
        </Match>
        <Match when={state().status === "deferred"}>
          <button
            class="bg-transparent border-none text-white/85 underline cursor-pointer text-xs p-0 hover:text-white"
            type="button"
            onClick={() => updaterStore.checkForUpdates(true)}
          >
            Update deferred – Check again
          </button>
        </Match>
        <Match when={state().status === "installing"}>
          <span class="inline-flex items-center gap-1 bg-white/15 py-0.5 px-2 rounded-full">
            Installing update…
          </span>
        </Match>
        <Match when={state().status === "error"}>
          <ErrorIndicator
            message={state().error || "Update failed"}
            onRetry={() => updaterStore.checkForUpdates(true)}
          />
        </Match>
      </Switch>
    </div>
  );
};

const IdleIndicator = (props: { onCheck: () => void }) => (
  <button
    class="bg-transparent border-none text-white/85 underline cursor-pointer text-xs p-0 hover:text-white"
    type="button"
    onClick={() => props.onCheck()}
  >
    Check for updates
  </button>
);

const AvailableIndicator = (props: {
  version?: string;
  error?: string;
  onInstall: () => Promise<void>;
  onDefer: () => void;
}) => (
  <div class="flex items-center gap-1.5">
    <span class="inline-flex items-center gap-1 bg-white/15 py-0.5 px-2 rounded-full">
      Update {props.version ? `v${props.version}` : "available"}
    </span>
    <button
      class="bg-green-500 border-none text-white text-xs py-1 px-2.5 rounded-md cursor-pointer hover:bg-green-600"
      type="button"
      onClick={() => props.onInstall()}
    >
      Install
    </button>
    <button
      class="bg-transparent text-white/85 border border-white/35 rounded-md text-xs py-1 px-2 cursor-pointer hover:text-white hover:border-white"
      type="button"
      onClick={() => props.onDefer()}
    >
      Later
    </button>
    <Show when={props.error}>
      <span class="text-red-200 text-[11px]">{props.error}</span>
    </Show>
  </div>
);

const ErrorIndicator = (props: { message: string; onRetry: () => void }) => (
  <div class="flex items-center gap-2">
    <span class="text-red-200 text-[11px]">{props.message}</span>
    <button
      class="bg-transparent text-white/85 border border-white/35 rounded-md text-xs py-1 px-2 cursor-pointer hover:text-white hover:border-white"
      type="button"
      onClick={() => props.onRetry()}
    >
      Retry
    </button>
  </div>
);
