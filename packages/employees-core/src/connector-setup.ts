// ABOUTME: Framework-agnostic controller for the connect-a-channel setup flow.
// ABOUTME: Shared by the desktop settings surface and the employees web app.
//
// Both the desktop settings surface and the hosted employees web app walk
// the same steps: choose a connector from the platform catalog, collect
// its credential fields, verify them live against the provider, then
// attach the connector reference and env-bound credential references to
// the managed deployment. Hosts supply their generated API clients
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

export interface ConnectorCredentialRefLike {
  name: string;
  ref_uri: string;
  kind: string;
  binding: string;
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
    credentials?: ConnectorCredentialRefLike[];
  }): Promise<{ error?: string }>;
  /// Persist one credential value as an organization secret so the
  /// deployment's `org-secret://` references resolve. Optional: hosts
  /// without a secret-store client fall back to attach-only, and the
  /// platform's pre-deploy validation names any missing secrets.
  storeSecret?(request: {
    name: string;
    value: string;
    description?: string;
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

/// Organization-secret key used by the wizard for one deployment field.
/// The injected credential name remains the provider env name, while the
/// stored key is deployment-scoped so connecting another employee cannot
/// rotate this employee's credential.
export function connectorSetupSecretStorageName(
  deploymentId: string,
  fieldName: string,
): string {
  return `connector-${deploymentId}-${fieldName}`;
}

/// Names of the organization secrets the attach step will reference.
export function connectorSetupSecretNames(
  entry: ConnectorCatalogEntryLike,
  values: Record<string, string>,
  deploymentId: string,
): string[] {
  const provided = connectorSetupProvidedValues(values);
  return entry.credentials
    .filter((field) => field.name in provided)
    .map((field) => connectorSetupSecretStorageName(deploymentId, field.name));
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

/// Env-bound `org-secret://` references for each provided credential field.
/// Existing same-name refs are corrected when they point at another store or
/// use a non-env binding, so a successful attach cannot silently leave the
/// connector without the organization secret that was just persisted.
export function connectorSetupMergeCredentialRefs(
  existing: ConnectorCredentialRefLike[],
  entry: ConnectorCatalogEntryLike,
  values: Record<string, string>,
  deploymentId: string,
): { merged: ConnectorCredentialRefLike[]; changed: number } {
  const provided = connectorSetupProvidedValues(values);
  const desired = new Map(
    entry.credentials
      .filter((field) => field.name in provided)
      .map(
        (field) =>
          [
            field.name,
            {
              name: field.name,
              ref_uri: `org-secret://${connectorSetupSecretStorageName(
                deploymentId,
                field.name,
              )}`,
              kind: "api_key",
              binding: "env",
            },
          ] as const,
      ),
  );
  let changed = 0;
  const existingNames = new Set(existing.map((ref) => ref.name));
  const merged = existing.map((ref) => {
    const replacement = desired.get(ref.name);
    if (!replacement) return ref;
    if (
      ref.ref_uri === replacement.ref_uri &&
      ref.kind === replacement.kind &&
      ref.binding === replacement.binding &&
      ref.binding_target === undefined
    ) {
      return ref;
    }
    changed += 1;
    const corrected: ConnectorCredentialRefLike = { ...ref, ...replacement };
    delete corrected.binding_target;
    return corrected;
  });
  for (const [name, addition] of desired) {
    if (existingNames.has(name)) continue;
    merged.push(addition);
    changed += 1;
  }
  return { merged, changed };
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

/// Run the attach step: store provided values as organization secrets
/// (when the host supplies a secret-store client), then update the
/// deployment. A store failure stops before attach so the flow never
/// attaches references to secrets that were not persisted.
export async function connectorSetupAttach(
  api: ConnectorSetupApi,
  state: ConnectorSetupState,
  entry: ConnectorCatalogEntryLike,
  deployment: {
    deploymentId: string;
    toolRefs: ConnectorToolRefLike[];
    credentials: ConnectorCredentialRefLike[];
  },
): Promise<ConnectorSetupState> {
  const busyState = { ...state, busy: true, error: null };
  if (api.storeSecret) {
    const provided = connectorSetupProvidedValues(busyState.values);
    for (const field of entry.credentials) {
      const value = provided[field.name];
      if (value === undefined) continue;
      const stored = await api.storeSecret({
        name: connectorSetupSecretStorageName(
          deployment.deploymentId,
          field.name,
        ),
        value,
        description: `${entry.display_name} connector credential`,
      });
      if (stored.error) {
        return { ...busyState, busy: false, error: stored.error };
      }
    }
  }
  const toolRefs = connectorSetupMergeToolRefs(deployment.toolRefs, entry);
  const { merged, changed } = connectorSetupMergeCredentialRefs(
    deployment.credentials,
    entry,
    busyState.values,
    deployment.deploymentId,
  );
  const result = await api.attachConnector({
    deploymentId: deployment.deploymentId,
    toolRefs,
    ...(changed > 0 ? { credentials: merged } : {}),
  });
  if (result.error) {
    return { ...busyState, busy: false, error: result.error };
  }
  // Drop the plaintext credential values once they are persisted server
  // side so completed flows do not retain tokens in host UI state.
  return { ...busyState, values: {}, busy: false, step: "done", error: null };
}
