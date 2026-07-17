// ABOUTME: Connectors settings section for attaching messaging channels.
// ABOUTME: Drives the shared employees-core connector setup controller.

import {
  CONNECTOR_SETUP_INITIAL_STATE,
  type ConnectorCatalogEntryLike,
  type ConnectorSetupApi,
  type ConnectorSetupState,
  connectorSetupAttach,
  connectorSetupBack,
  connectorSetupEnterValue,
  connectorSetupProvidedFieldNames,
  connectorSetupRequiredFieldsFilled,
  connectorSetupSelect,
  connectorSetupVerify,
  VERIFIABLE_CONNECTOR_REFS,
} from "@seren/employees-core";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import {
  serenAgentGetManagedDeployment,
  serenAgentListDeployments,
  serenAgentUpdateManagedDeployment,
} from "@/api/seren-agent";
import {
  serenCloudBindConnectorSecrets,
  serenCloudListConnectors,
  serenCloudPreviewManagedEmployeeSecretRefs,
  serenCloudVerifyConnectorCredentials,
} from "@/api/seren-cloud";
import { formatApiError } from "@/lib/api-errors";
import { openExternalLink } from "@/lib/external-link";
import {
  createPasswordsEmployeeDelegation,
  ensurePasswordsEmployeeIdentity,
  savePasswordsEmployeeCredential,
} from "@/services/keys";
import { loadedResource, loadResourceState } from "./resource-state";

const setupApi: ConnectorSetupApi = {
  async verifyCredentials(connectorRef, credentials) {
    const result = await serenCloudVerifyConnectorCredentials({
      path: { connector_ref: connectorRef },
      body: { credentials },
      throwOnError: false,
    });
    if (result.error || !result.data) {
      return { transportError: "Verification request failed. Try again." };
    }
    return result.data.data;
  },
  async attachConnector(request) {
    const result = await serenAgentUpdateManagedDeployment({
      path: { id: request.deploymentId },
      body: {
        tool_refs: request.toolRefs as never,
        agent_identity_id: request.agentIdentityId,
        secret_resolution_delegation: request.secretResolutionDelegation,
      },
      throwOnError: false,
    });
    if (result.error) {
      return {
        error: formatApiError(
          result.error,
          result.response,
          "The deployment update was rejected.",
        ),
      };
    }
    return {};
  },
  async ensureEmployeeIdentity(request) {
    try {
      const identity = await ensurePasswordsEmployeeIdentity(
        request.deploymentId,
        request.displayName,
      );
      if (request.currentAgentIdentityId !== identity.agentIdentityId) {
        const update = await serenAgentUpdateManagedDeployment({
          path: { id: request.deploymentId },
          body: { agent_identity_id: identity.agentIdentityId },
          throwOnError: false,
        });
        if (update.error) {
          return {
            error: formatApiError(
              update.error,
              update.response,
              "The employee identity could not be attached.",
            ),
          };
        }
      }
      return { agentIdentityId: identity.agentIdentityId };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  async storeCredential(request) {
    try {
      const stored = await savePasswordsEmployeeCredential({
        deploymentId: request.deploymentId,
        title: request.title,
        serviceName: request.serviceName,
        fields: Object.entries(request.credentials).map(([name, value]) => ({
          name,
          value,
        })),
      });
      return { references: stored.references };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  async bindConnectorSecrets(request) {
    const result = await serenCloudBindConnectorSecrets({
      path: {
        id: request.deploymentId,
        connector_ref: request.connectorRef,
      },
      body: { secret_refs: request.secretRefs },
      throwOnError: false,
    });
    if (result.error || !result.data) {
      return {
        error: formatApiError(
          result.error,
          result.response,
          "The connector credential references could not be bound.",
        ),
      };
    }
    return { secretRefs: result.data.data.secret_refs };
  },
  async previewEmployeeSecretRefs(request) {
    const result = await serenCloudPreviewManagedEmployeeSecretRefs({
      path: { id: request.deploymentId },
      body: { additional_refs: request.additionalRefs },
      throwOnError: false,
    });
    if (result.error || !result.data) {
      return {
        error: formatApiError(
          result.error,
          result.response,
          "The complete credential reference set could not be prepared.",
        ),
      };
    }
    return { secretRefs: result.data.data.secret_refs };
  },
  async createEmployeeDelegation(request) {
    try {
      const delegation = await createPasswordsEmployeeDelegation(request);
      return {
        secretResolutionDelegation: delegation.secretResolutionDelegation,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  async authorizeEmployeeDelegation(request) {
    const result = await serenAgentUpdateManagedDeployment({
      path: { id: request.deploymentId },
      body: {
        agent_identity_id: request.agentIdentityId,
        secret_resolution_delegation: request.secretResolutionDelegation,
      },
      throwOnError: false,
    });
    if (result.error) {
      return {
        error: formatApiError(
          result.error,
          result.response,
          "The employee secret authorization could not be installed.",
        ),
      };
    }
    return {};
  },
};

export function ConnectorSettings() {
  const [state, setState] = createSignal<ConnectorSetupState>(
    CONNECTOR_SETUP_INITIAL_STATE,
  );
  const [employeeId, setEmployeeId] = createSignal("");

  const [deploymentState] = createResource(() =>
    loadResourceState(async () => {
      const result = await serenAgentListDeployments({ throwOnError: false });
      if (result.error || !result.data) {
        throw new Error("Cloud employees could not be loaded");
      }
      return result.data.data;
    }, []),
  );
  const [catalogState] = createResource(() =>
    loadResourceState(async () => {
      const result = await serenCloudListConnectors({ throwOnError: false });
      if (result.error || !result.data) {
        throw new Error("Connectors could not be loaded");
      }
      return result.data.data.connectors;
    }, []),
  );
  const employees = createMemo(() =>
    (deploymentState()?.data ?? []).filter(
      (deployment) => deployment.managed_agent,
    ),
  );
  const selectedEmployee = createMemo(
    () =>
      employees().find((deployment) => deployment.id === employeeId()) ?? null,
  );
  const [detailState, { refetch: refetchDetail }] = createResource(
    employeeId,
    async (id) => {
      if (!id) return loadedResource(null);
      return loadResourceState(async () => {
        const result = await serenAgentGetManagedDeployment({
          path: { id },
          throwOnError: false,
        });
        if (result.error || !result.data) {
          throw new Error("Employee details could not be loaded");
        }
        return result.data.data;
      }, null);
    },
  );
  const catalog = createMemo(() => catalogState()?.data ?? []);
  const detail = createMemo(() => detailState()?.data ?? null);

  const selectedEntry = createMemo<ConnectorCatalogEntryLike | null>(() => {
    const current = state();
    return (
      catalog().find((entry) => entry.connector_ref === current.selectedRef) ??
      null
    );
  });

  function employeeHasConnector(connectorRef: string): boolean {
    return (detail()?.tool_refs ?? []).some(
      (ref) => ref.kind === "connector" && ref.connector_ref === connectorRef,
    );
  }

  async function verify() {
    const entry = selectedEntry();
    if (!entry || state().busy) return;
    const id = employeeId();
    setState((current) => ({ ...current, busy: true, error: null }));
    const next = await connectorSetupVerify(setupApi, state(), entry);
    // The employee select resets the wizard; a result that raced that
    // reset would resurrect the old flow against the new employee.
    if (employeeId() !== id) return;
    setState(next);
  }

  async function attach() {
    const entry = selectedEntry();
    const currentDetail = detail();
    const employee = selectedEmployee();
    if (!entry || !currentDetail || !employee || state().busy) return;
    const id = employeeId();
    setState((current) => ({ ...current, busy: true, error: null }));
    const next = await connectorSetupAttach(setupApi, state(), entry, {
      deploymentId: id,
      organizationId: employee.organization_id,
      displayName: currentDetail.name,
      agentIdentityId: currentDetail.agent_identity_id,
      toolRefs: currentDetail.tool_refs ?? [],
    });
    if (employeeId() !== id) return;
    setState(next);
    if (next.step === "done") void refetchDetail();
  }

  return (
    <section class="max-w-[760px]">
      <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Connectors</h3>
      <p class="m-0 mb-6 max-w-[680px] text-[0.9rem] leading-relaxed text-muted-foreground">
        Connect messaging channels such as Slack and Telegram to a cloud
        employee. Seren verifies credentials when the provider supports a live
        check.
      </p>

      <div class="overflow-hidden rounded-lg border border-border bg-surface-1/40">
        <div class="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
          <label
            class="flex min-w-0 flex-1 flex-col gap-0.5"
            for="connector-employee"
          >
            <span class="text-[0.95rem] font-medium text-foreground">
              Cloud employee
            </span>
            <span class="text-[0.8rem] leading-normal text-muted-foreground">
              Choose the employee that should receive this channel.
            </span>
          </label>
          <select
            class="h-9 w-full rounded-md border border-border-strong bg-surface-3/80 px-3 text-[0.9rem] text-foreground focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 lg:w-[280px]"
            disabled={deploymentState.loading || deploymentState()?.failed}
            id="connector-employee"
            onChange={(event) => {
              setEmployeeId(event.currentTarget.value);
              setState(CONNECTOR_SETUP_INITIAL_STATE);
            }}
            value={employeeId()}
          >
            <option value="">
              {deploymentState.loading
                ? "Loading cloud employees..."
                : "Select a cloud employee"}
            </option>
            <For each={employees()}>
              {(deployment) => (
                <option value={deployment.id}>
                  {deployment.name ?? deployment.id}
                </option>
              )}
            </For>
          </select>
        </div>

        <Show when={deploymentState()?.failed}>
          <div class="border-t border-destructive/30 bg-destructive/10 px-4 py-3 text-[0.85rem] text-destructive">
            Cloud employees could not be loaded. Try opening this section again.
          </div>
        </Show>
      </div>

      <Show when={employeeId() && state().step === "choose"}>
        <div class="mt-6">
          <div class="mb-3">
            <h4 class="m-0 text-base font-semibold text-foreground">
              Choose a channel
            </h4>
            <p class="m-0 mt-1 text-[0.8rem] text-muted-foreground">
              Existing attachments are shown for the selected employee.
            </p>
          </div>

          <Show when={detailState()?.failed}>
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[0.85rem] text-destructive">
              <span>Employee details could not be loaded.</span>
              <button
                class="rounded-md border border-destructive/40 bg-transparent px-2.5 py-1 text-[0.8rem] font-medium text-destructive transition-colors hover:bg-destructive/10"
                onClick={() => void refetchDetail()}
                type="button"
              >
                Retry
              </button>
            </div>
          </Show>
          <Show
            fallback={
              <div class="rounded-lg border border-border bg-surface-1/30 px-4 py-6 text-center text-[0.85rem] text-muted-foreground">
                Loading connectors...
              </div>
            }
            when={!catalogState.loading}
          >
            <Show
              fallback={
                <div class="rounded-md border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[0.85rem] text-destructive">
                  Connectors could not be loaded. Try opening this section
                  again.
                </div>
              }
              when={!catalogState()?.failed}
            >
              <div class="grid gap-2">
                <For each={catalog()}>
                  {(entry) => (
                    <button
                      class="group flex w-full items-start justify-between gap-4 rounded-lg border border-border bg-surface-1/40 px-4 py-3.5 text-left transition-colors hover:border-accent/60 hover:bg-surface-2/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface-1/40"
                      disabled={!detail()}
                      onClick={() =>
                        setState(connectorSetupSelect(state(), entry))
                      }
                      type="button"
                    >
                      <span class="min-w-0 flex-1">
                        <span class="block text-[0.95rem] font-medium text-foreground">
                          {entry.display_name}
                        </span>
                        <span class="mt-1 block text-[0.8rem] leading-normal text-muted-foreground">
                          {entry.description}
                        </span>
                      </span>
                      <Show
                        fallback={
                          <Show when={entry.connected}>
                            <span class="shrink-0 rounded-full border border-border-strong bg-surface-3/70 px-2.5 py-1 text-[0.7rem] font-medium text-muted-foreground">
                              Connected to organization
                            </span>
                          </Show>
                        }
                        when={employeeHasConnector(entry.connector_ref)}
                      >
                        <span class="shrink-0 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[0.7rem] font-medium text-success">
                          Attached
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>

      <Show when={state().step === "credentials" && selectedEntry()}>
        {(entry) => (
          <div class="mt-6 rounded-lg border border-border bg-surface-1/40 p-4">
            <div class="mb-4 border-b border-border pb-3">
              <div class="text-[0.72rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Channel credentials
              </div>
              <h4 class="m-0 mt-1 text-base font-semibold text-foreground">
                Connect {entry().display_name}
              </h4>
              <Show when={entry().setup_url}>
                <div class="mt-1.5">
                  <button
                    class="cursor-pointer border-0 bg-transparent p-0 text-left text-[0.8rem] text-accent hover:underline"
                    onClick={() => {
                      const setupUrl = entry().setup_url;
                      if (setupUrl) void openExternalLink(setupUrl);
                    }}
                    type="button"
                  >
                    {entry().connector_ref === "slack"
                      ? "Open Slack Your Apps"
                      : "Open the provider console to create credentials"}
                  </button>
                  <Show when={entry().connector_ref === "slack"}>
                    <div class="mt-2 max-w-[620px] rounded-md border border-border bg-surface-0/50 px-3 py-2.5 text-[0.78rem] leading-relaxed text-muted-foreground">
                      <p class="m-0 font-medium text-foreground">
                        From Slack's Your Apps page:
                      </p>
                      <ol class="m-0 mt-1.5 grid gap-1 pl-4">
                        <li>
                          Click Create an App, then choose From scratch. Enter
                          an app name, select your workspace, and click Create
                          App. If your app already appears on this page, select
                          it instead.
                        </li>
                        <li>
                          Do not click Generate Token under Your App
                          Configuration Tokens. Seren does not use that token.
                        </li>
                        <li>
                          In OAuth &amp; Permissions, add the Bot Token Scopes{" "}
                          <code>chat:write</code> and{" "}
                          <code>app_mentions:read</code>. Click Install to
                          Workspace and approve the installation.
                        </li>
                        <li>
                          Copy the Bot User OAuth Token beginning with{" "}
                          <code>xoxb-</code> and paste it into Bot token below.
                        </li>
                        <li>
                          In Socket Mode, turn on Enable Socket Mode. In the
                          token prompt, enter a name, add the{" "}
                          <code>connections:write</code> scope, and click
                          Generate.
                        </li>
                        <li>
                          Copy the generated <code>xapp-</code> token and paste
                          it into App-level token below.
                        </li>
                      </ol>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
            <div class="grid gap-3">
              <For each={entry().credentials}>
                {(field) => (
                  <label class="grid gap-1.5">
                    <span class="text-[0.85rem] font-medium text-foreground">
                      {field.label}
                      <Show when={!field.required}>
                        <span class="font-normal text-muted-foreground">
                          {" "}
                          (optional)
                        </span>
                      </Show>
                    </span>
                    <input
                      autocomplete="off"
                      class="h-9 w-full rounded-md border border-border-strong bg-surface-3/80 px-3 text-[0.85rem] text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={state().busy}
                      onInput={(event) =>
                        setState(
                          connectorSetupEnterValue(
                            state(),
                            field.name,
                            event.currentTarget.value,
                          ),
                        )
                      }
                      placeholder={field.format_hint ?? undefined}
                      type={field.secret ? "password" : "text"}
                      value={state().values[field.name] ?? ""}
                    />
                  </label>
                )}
              </For>
            </div>
            <div class="mt-5 flex flex-wrap items-center gap-2">
              <button
                class="rounded-md border border-accent bg-accent px-4 py-2 text-[0.85rem] font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !connectorSetupRequiredFieldsFilled(
                    entry(),
                    state().values,
                  ) || state().busy
                }
                onClick={() => void verify()}
                type="button"
              >
                {state().busy
                  ? "Verifying..."
                  : VERIFIABLE_CONNECTOR_REFS.has(entry().connector_ref)
                    ? "Verify and continue"
                    : "Continue"}
              </button>
              <button
                class="rounded-md border border-border-strong bg-transparent px-4 py-2 text-[0.85rem] font-medium text-muted-foreground transition-colors hover:bg-surface-3/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={state().busy}
                onClick={() => setState(connectorSetupBack(state()))}
                type="button"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={state().step === "attach" && selectedEntry()}>
        {(entry) => (
          <div class="mt-6 rounded-lg border border-border bg-surface-1/40 p-4">
            <div class="mb-3">
              <div class="text-[0.72rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Confirm attachment
              </div>
              <h4 class="m-0 mt-1 text-base font-semibold text-foreground">
                Attach {entry().display_name}
              </h4>
            </div>
            <Show when={state().verifiedIdentity}>
              <div class="mb-3 rounded-md border border-success/30 bg-success/10 px-3.5 py-2.5 text-[0.85rem] text-success">
                Verified as {state().verifiedIdentity}.
              </div>
            </Show>
            <p class="m-0 text-[0.85rem] leading-relaxed text-muted-foreground">
              The provided values will be encrypted in a dedicated Seren
              Passwords vault for this employee. The employee receives read-only
              access to that vault, while its scripts receive only opaque
              references. Unlock Seren Passwords before attaching the channel.
            </p>
            <ul class="my-3 grid gap-1 rounded-md border border-border bg-surface-0/50 px-3 py-2.5">
              <For
                each={connectorSetupProvidedFieldNames(entry(), state().values)}
              >
                {(name) => (
                  <li class="list-none font-mono text-[0.75rem] text-muted-foreground">
                    {name}
                  </li>
                )}
              </For>
            </ul>
            <div class="flex flex-wrap items-center gap-2">
              <button
                class="rounded-md border border-accent bg-accent px-4 py-2 text-[0.85rem] font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={state().busy}
                onClick={() => void attach()}
                type="button"
              >
                {state().busy ? "Attaching..." : "Attach channel"}
              </button>
              <button
                class="rounded-md border border-border-strong bg-transparent px-4 py-2 text-[0.85rem] font-medium text-muted-foreground transition-colors hover:bg-surface-3/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={state().busy}
                onClick={() => setState(connectorSetupBack(state()))}
                type="button"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show when={state().step === "done" && selectedEntry()}>
        {(entry) => (
          <div class="mt-6 rounded-md border border-success/30 bg-success/10 px-3.5 py-3 text-[0.85rem] text-success">
            {entry().display_name} is attached. Seren provisions the inbound
            webhook route automatically.
          </div>
        )}
      </Show>

      <Show when={state().error}>
        <div class="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[0.85rem] text-destructive">
          {state().error}
        </div>
      </Show>
    </section>
  );
}
