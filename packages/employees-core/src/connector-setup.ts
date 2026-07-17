// ABOUTME: Framework-agnostic controller for the connect-a-channel setup flow.
// ABOUTME: Shared by the desktop settings surface and the employees web app.
//
// Both the desktop settings surface and the hosted employees web app walk
// the same steps: choose a connector from the platform catalog, collect
// its credential fields, verify them live against the provider, then store
// them in Seren Passwords and authorize the managed employee to resolve
// only their opaque references. Hosts supply their generated API clients
// through `ConnectorSetupApi`; this module owns the state transitions so
// the flow behaves identically everywhere.

export type ConnectorSetupStep = "choose" | "credentials" | "attach" | "done";

/// Connectors with a live server-side credential verification probe.
export const VERIFIABLE_CONNECTOR_REFS: ReadonlySet<string> = new Set([
  "slack",
  "telegram",
]);

export interface ConnectorCredentialFieldLike {
  name: string;
  label: string;
  required: boolean;
  secret: boolean;
  format_hint?: string | null;
}

export interface ConnectorCatalogEntryLike {
  connector_ref: string;
  display_name: string;
  description: string;
  capability: string;
  credentials: ConnectorCredentialFieldLike[];
  setup_url?: string | null;
  supports_webhook_ingress: boolean;
  requires_always_on: boolean;
  connected: boolean;
}

export interface ConnectorVerificationLike {
  ok: boolean;
  identity?: string | null;
  failure_reason?: string | null;
}

export interface ConnectorToolRefLike {
  kind: string;
  connector_ref?: string | null;
  capability?: string | null;
  [extra: string]: unknown;
}

export interface ConnectorSetupState {
  step: ConnectorSetupStep;
  selectedRef: string | null;
  values: Record<string, string>;
  verifiedIdentity: string | null;
  error: string | null;
  busy: boolean;
}

export const CONNECTOR_SETUP_INITIAL_STATE: ConnectorSetupState = {
  step: "choose",
  selectedRef: null,
  values: {},
  verifiedIdentity: null,
  error: null,
  busy: false,
};

/// Host-supplied API surface. Implementations adapt the host's generated
/// SDK clients; errors must be returned, not thrown, so the controller
/// can keep the flow resumable.
export interface ConnectorSetupApi {
  verifyCredentials(
    connectorRef: string,
    credentials: Record<string, string>,
  ): Promise<ConnectorVerificationLike | { transportError: string }>;
  attachConnector(request: {
    deploymentId: string;
    toolRefs: ConnectorToolRefLike[];
    agentIdentityId: string;
    secretResolutionDelegation: string;
  }): Promise<{ error?: string }>;
  ensureEmployeeIdentity(request: {
    deploymentId: string;
    displayName: string;
    currentAgentIdentityId?: string | null;
  }): Promise<{ agentIdentityId?: string; error?: string }>;
  storeCredential(request: {
    deploymentId: string;
    title: string;
    serviceName: string;
    credentials: Record<string, string>;
  }): Promise<{ references?: Record<string, string>; error?: string }>;
  bindConnectorSecrets(request: {
    deploymentId: string;
    connectorRef: string;
    secretRefs: Record<string, string>;
  }): Promise<{ secretRefs?: string[]; error?: string }>;
  previewEmployeeSecretRefs(request: {
    deploymentId: string;
    additionalRefs: string[];
  }): Promise<{ secretRefs?: string[]; error?: string }>;
  createEmployeeDelegation(request: {
    deploymentId: string;
    organizationId: string;
    agentIdentityId: string;
    secretRefs: string[];
  }): Promise<{ secretResolutionDelegation?: string; error?: string }>;
  authorizeEmployeeDelegation(request: {
    deploymentId: string;
    agentIdentityId: string;
    secretResolutionDelegation: string;
  }): Promise<{ error?: string }>;
}

export function connectorSetupSelect(
  _state: ConnectorSetupState,
  entry: ConnectorCatalogEntryLike,
): ConnectorSetupState {
  return {
    ...CONNECTOR_SETUP_INITIAL_STATE,
    step: "credentials",
    selectedRef: entry.connector_ref,
  };
}

export function connectorSetupEnterValue(
  state: ConnectorSetupState,
  fieldName: string,
  value: string,
): ConnectorSetupState {
  return {
    ...state,
    values: { ...state.values, [fieldName]: value },
    error: null,
  };
}

export function connectorSetupBack(
  state: ConnectorSetupState,
): ConnectorSetupState {
  if (state.step === "credentials") {
    return { ...CONNECTOR_SETUP_INITIAL_STATE };
  }
  if (state.step === "attach") {
    return {
      ...state,
      step: "credentials",
      verifiedIdentity: null,
      error: null,
    };
  }
  return state;
}

export function connectorSetupRequiredFieldsFilled(
  entry: ConnectorCatalogEntryLike,
  values: Record<string, string>,
): boolean {
  return entry.credentials
    .filter((field) => field.required)
    .every((field) => (values[field.name] ?? "").trim().length > 0);
}

/// The provided (non-empty) credential values, keyed by field name.
export function connectorSetupProvidedValues(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([name, value]) => [name, value.trim()])
      .filter(([, value]) => value.length > 0),
  );
}

/// Credential field names the attach step will store in Seren Passwords.
export function connectorSetupProvidedFieldNames(
  entry: ConnectorCatalogEntryLike,
  values: Record<string, string>,
): string[] {
  const provided = connectorSetupProvidedValues(values);
  return entry.credentials
    .filter((field) => field.name in provided)
    .map((field) => field.name);
}

/// Merge the connector tool ref into the deployment's existing refs.
/// Existing same-ref connector entries are normalized to the catalog
/// capability so webhook routing cannot remain disabled by stale metadata.
export function connectorSetupMergeToolRefs(
  existing: ConnectorToolRefLike[],
  entry: ConnectorCatalogEntryLike,
): ConnectorToolRefLike[] {
  const existingIndex = existing.findIndex(
    (ref) =>
      ref.kind === "connector" && ref.connector_ref === entry.connector_ref,
  );
  if (existingIndex >= 0) {
    const current = existing[existingIndex];
    if (current.capability === entry.capability) return existing;
    return existing.map((ref, index) =>
      index === existingIndex ? { ...ref, capability: entry.capability } : ref,
    );
  }
  return [
    ...existing,
    {
      kind: "connector",
      connector_ref: entry.connector_ref,
      capability: entry.capability,
    },
  ];
}

/// Run the live verification step. Connectors without a verification
/// probe advance directly to the attach step.
export async function connectorSetupVerify(
  api: ConnectorSetupApi,
  state: ConnectorSetupState,
  entry: ConnectorCatalogEntryLike,
): Promise<ConnectorSetupState> {
  if (!VERIFIABLE_CONNECTOR_REFS.has(entry.connector_ref)) {
    return { ...state, step: "attach", verifiedIdentity: null, error: null };
  }
  const busyState = { ...state, busy: true, error: null };
  const outcome = await api.verifyCredentials(
    entry.connector_ref,
    connectorSetupProvidedValues(busyState.values),
  );
  if ("transportError" in outcome) {
    return { ...busyState, busy: false, error: outcome.transportError };
  }
  if (!outcome.ok) {
    return {
      ...busyState,
      busy: false,
      error: `The provider rejected these credentials: ${
        outcome.failure_reason ?? "unknown reason"
      }.`,
    };
  }
  return {
    ...busyState,
    busy: false,
    step: "attach",
    verifiedIdentity: outcome.identity ?? "verified",
  };
}

/// Run the attach step through the Passwords trust boundary. Plaintext is
/// handed only to the host's local Passwords implementation; Core receives
/// opaque references and a user-signed delegation for their complete set.
export async function connectorSetupAttach(
  api: ConnectorSetupApi,
  state: ConnectorSetupState,
  entry: ConnectorCatalogEntryLike,
  deployment: {
    deploymentId: string;
    organizationId: string;
    displayName: string;
    agentIdentityId?: string | null;
    toolRefs: ConnectorToolRefLike[];
  },
): Promise<ConnectorSetupState> {
  try {
    return await connectorSetupAttachInner(api, state, entry, deployment);
  } catch (error) {
    return {
      ...state,
      busy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function connectorSetupAttachInner(
  api: ConnectorSetupApi,
  state: ConnectorSetupState,
  entry: ConnectorCatalogEntryLike,
  deployment: {
    deploymentId: string;
    organizationId: string;
    displayName: string;
    agentIdentityId?: string | null;
    toolRefs: ConnectorToolRefLike[];
  },
): Promise<ConnectorSetupState> {
  const busyState = { ...state, busy: true, error: null };
  const identity = await api.ensureEmployeeIdentity({
    deploymentId: deployment.deploymentId,
    displayName: deployment.displayName,
    currentAgentIdentityId: deployment.agentIdentityId,
  });
  if (identity.error || !identity.agentIdentityId) {
    return {
      ...busyState,
      busy: false,
      error: identity.error ?? "The employee identity could not be created.",
    };
  }

  const stored = await api.storeCredential({
    deploymentId: deployment.deploymentId,
    title: `${deployment.displayName} - ${entry.display_name}`,
    serviceName: entry.connector_ref,
    credentials: connectorSetupProvidedValues(busyState.values),
  });
  if (stored.error || !stored.references) {
    return {
      ...busyState,
      busy: false,
      error: stored.error ?? "The credential could not be stored.",
    };
  }

  const preview = await api.previewEmployeeSecretRefs({
    deploymentId: deployment.deploymentId,
    additionalRefs: Object.values(stored.references),
  });
  if (preview.error || !preview.secretRefs) {
    return {
      ...busyState,
      busy: false,
      error:
        preview.error ??
        "The complete credential reference set could not be prepared.",
    };
  }

  const delegation = await api.createEmployeeDelegation({
    deploymentId: deployment.deploymentId,
    organizationId: deployment.organizationId,
    agentIdentityId: identity.agentIdentityId,
    secretRefs: preview.secretRefs,
  });
  if (delegation.error || !delegation.secretResolutionDelegation) {
    return {
      ...busyState,
      busy: false,
      error:
        delegation.error ??
        "The employee secret access could not be authorized.",
    };
  }

  const authorized = await api.authorizeEmployeeDelegation({
    deploymentId: deployment.deploymentId,
    agentIdentityId: identity.agentIdentityId,
    secretResolutionDelegation: delegation.secretResolutionDelegation,
  });
  if (authorized.error) {
    return { ...busyState, busy: false, error: authorized.error };
  }

  const bound = await api.bindConnectorSecrets({
    deploymentId: deployment.deploymentId,
    connectorRef: entry.connector_ref,
    secretRefs: stored.references,
  });
  if (bound.error || !bound.secretRefs) {
    return {
      ...busyState,
      busy: false,
      error: bound.error ?? "The credential references could not be bound.",
    };
  }
  const authorizedRefs = new Set(preview.secretRefs);
  if (bound.secretRefs.some((reference) => !authorizedRefs.has(reference))) {
    return {
      ...busyState,
      busy: false,
      error:
        "The employee credentials changed during authorization. Retry the attachment.",
    };
  }

  const toolRefs = connectorSetupMergeToolRefs(deployment.toolRefs, entry);
  const result = await api.attachConnector({
    deploymentId: deployment.deploymentId,
    toolRefs,
    agentIdentityId: identity.agentIdentityId,
    secretResolutionDelegation: delegation.secretResolutionDelegation,
  });
  if (result.error) {
    return { ...busyState, busy: false, error: result.error };
  }
  // Drop the plaintext credential values once they are persisted server
  // side so completed flows do not retain tokens in host UI state.
  return { ...busyState, values: {}, busy: false, step: "done", error: null };
}
