import { Match, Show, Switch } from "solid-js";
import { updaterStore } from "@/stores/updater.store";
import "./UpdateIndicator.css";

export const UpdateIndicator = () => {
  const state = () => updaterStore.state;

  return (
    <div class="update-indicator" data-status={state().status}>
      <Switch
        fallback={
          <IdleIndicator onCheck={() => updaterStore.checkForUpdates(true)} />
        }
      >
        <Match when={state().status === "checking"}>
          <span class="update-pill">Checking for updates…</span>
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
            class="update-link"
            type="button"
            onClick={() => updaterStore.checkForUpdates(true)}
          >
            Update deferred – Check again
          </button>
        </Match>
        <Match when={state().status === "installing"}>
          <span class="update-pill">Installing update…</span>
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
  <button class="update-link" type="button" onClick={() => props.onCheck()}>
    Check for updates
  </button>
);

const AvailableIndicator = (props: {
  version?: string;
  error?: string;
  onInstall: () => Promise<void>;
  onDefer: () => void;
}) => (
  <div class="update-available">
    <span class="update-pill">
      Update {props.version ? `v${props.version}` : "available"}
    </span>
    <button class="btn-update" type="button" onClick={() => props.onInstall()}>
      Install
    </button>
    <button class="btn-defer" type="button" onClick={() => props.onDefer()}>
      Later
    </button>
    <Show when={props.error}>
      <span class="update-error">{props.error}</span>
    </Show>
  </div>
);

const ErrorIndicator = (props: { message: string; onRetry: () => void }) => (
  <div class="update-error-indicator">
    <span class="update-error">{props.message}</span>
    <button class="btn-defer" type="button" onClick={() => props.onRetry()}>
      Retry
    </button>
  </div>
);
