// ABOUTME: Small typed-tool authoring helpers for managed employee forms.
// ABOUTME: Keeps connector presets as AgentToolRef data instead of prompt text.

import type { AgentToolRef } from "@/api/seren-agent";

export type ConnectorAccessMode = "none" | "gmail_read" | "gmail_send_approval";

export type ConnectorAccessOption = {
  value: ConnectorAccessMode;
  title: string;
  sub: string;
};

export const CONNECTOR_ACCESS_OPTIONS: ConnectorAccessOption[] = [
  { value: "none", title: "None", sub: "No connector ref" },
  { value: "gmail_read", title: "Gmail read", sub: "Read-only messaging" },
  {
    value: "gmail_send_approval",
    title: "Gmail send",
    sub: "Send requires approval",
  },
];

// Canonical managed-preset shapes the form emits. The discriminator only treats
// a ref as "form-owned" when it matches one of these exactly; any other gmail
// messaging ref is user-authored and must be preserved across mode toggles.
const GMAIL_READ_PRESET: AgentToolRef = {
  kind: "connector",
  connector_ref: "gmail",
  capability: "messaging",
  scopes: ["read"],
  require_approval: false,
  permitted_actions: [{ action: "read", capability: { kind: "all" } }],
};

const GMAIL_SEND_APPROVAL_PRESET: AgentToolRef = {
  kind: "connector",
  connector_ref: "gmail",
  capability: "messaging",
  scopes: ["read", "send"],
  require_approval: true,
  permitted_actions: [
    { action: "read", capability: { kind: "all" } },
    {
      action: "send",
      capability: { kind: "specific", actions: ["email"] },
    },
  ],
};

function clonePreset(ref: AgentToolRef): AgentToolRef {
  return structuredClone(ref);
}

function isGmailMessagingConnector(ref: AgentToolRef): boolean {
  return (
    ref.kind === "connector" &&
    ref.connector_ref === "gmail" &&
    ref.capability === "messaging" &&
    (sameToolRef(ref, GMAIL_READ_PRESET) ||
      sameToolRef(ref, GMAIL_SEND_APPROVAL_PRESET))
  );
}

function gmailConnectorForMode(
  mode: ConnectorAccessMode,
): AgentToolRef | undefined {
  if (mode === "gmail_read") return clonePreset(GMAIL_READ_PRESET);
  if (mode === "gmail_send_approval")
    return clonePreset(GMAIL_SEND_APPROVAL_PRESET);
  return undefined;
}

export function connectorAccessModeFromToolRefs(
  refs: readonly AgentToolRef[],
): ConnectorAccessMode {
  for (const ref of refs) {
    if (sameToolRef(ref, GMAIL_READ_PRESET)) return "gmail_read";
    if (sameToolRef(ref, GMAIL_SEND_APPROVAL_PRESET))
      return "gmail_send_approval";
  }
  return "none";
}

export function mergeConnectorAccessToolRefs(
  existing: readonly AgentToolRef[],
  mode: ConnectorAccessMode,
): AgentToolRef[] {
  const refs = existing.filter((ref) => !isGmailMessagingConnector(ref));
  const gmail = gmailConnectorForMode(mode);
  if (gmail) refs.push(gmail);
  return refs;
}

// Compare two tool-ref lists element-wise with a structural equality check
// rather than relying on JSON.stringify (which is sensitive to key order and
// whether optional fields are emitted vs omitted).
export function sameToolRefs(
  left: readonly AgentToolRef[],
  right: readonly AgentToolRef[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!sameToolRef(left[i], right[i])) return false;
  }
  return true;
}

function sameToolRef(a: AgentToolRef, b: AgentToolRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "publisher": {
      if (b.kind !== "publisher") return false;
      return (
        a.publisher_slug === b.publisher_slug &&
        a.operation_id === b.operation_id &&
        sameOptionalBool(a.require_approval, b.require_approval) &&
        sameActionLeases(a.permitted_actions, b.permitted_actions)
      );
    }
    case "mcp": {
      if (b.kind !== "mcp") return false;
      return (
        a.server_ref === b.server_ref &&
        a.tool_name === b.tool_name &&
        sameOptionalBool(a.require_approval, b.require_approval) &&
        sameActionLeases(a.permitted_actions, b.permitted_actions)
      );
    }
    case "connector": {
      if (b.kind !== "connector") return false;
      return (
        a.connector_ref === b.connector_ref &&
        a.capability === b.capability &&
        sameOptionalBool(a.require_approval, b.require_approval) &&
        sameStringMultiset(a.scopes, b.scopes) &&
        sameActionLeases(a.permitted_actions, b.permitted_actions)
      );
    }
    case "remote_agent": {
      if (b.kind !== "remote_agent") return false;
      return (
        a.origin === b.origin &&
        a.transport === b.transport &&
        deepEqual(a.auth_mode, b.auth_mode) &&
        (a.expected_card_digest ?? null) === (b.expected_card_digest ?? null) &&
        (a.timeout_ms ?? null) === (b.timeout_ms ?? null) &&
        sameOptionalBool(a.require_approval, b.require_approval) &&
        sameActionLeases(a.permitted_actions, b.permitted_actions)
      );
    }
    case "preset_group": {
      if (b.kind !== "preset_group") return false;
      return a.preset === b.preset;
    }
    default:
      // Unknown kind: fall back to deep equality so future variants do not
      // silently collapse together.
      return deepEqual(a, b);
  }
}

function sameOptionalBool(a: boolean | undefined, b: boolean | undefined) {
  // Backend treats missing as `false` for these flags, so unify undefined/false.
  return (a ?? false) === (b ?? false);
}

function sameStringMultiset(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
) {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  for (let i = 0; i < sortedLeft.length; i += 1) {
    if (sortedLeft[i] !== sortedRight[i]) return false;
  }
  return true;
}

type ActionLeaseLike = NonNullable<
  Extract<AgentToolRef, { permitted_actions?: unknown }>["permitted_actions"]
>[number];

function sameActionLeases(
  a: readonly ActionLeaseLike[] | undefined,
  b: readonly ActionLeaseLike[] | undefined,
) {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  const keyed = (lease: ActionLeaseLike) =>
    JSON.stringify([
      lease.action,
      capabilityKey(lease.capability),
      lease.expiry ?? "",
      lease.parent_lease_ref ?? "",
      lease.use_budget ?? "",
    ]);
  const sortedLeft = [...left].map(keyed).sort();
  const sortedRight = [...right].map(keyed).sort();
  for (let i = 0; i < sortedLeft.length; i += 1) {
    if (sortedLeft[i] !== sortedRight[i]) return false;
  }
  return true;
}

function capabilityKey(cap: ActionLeaseLike["capability"]): string {
  if (cap.kind === "all") return "all";
  const sorted = [...cap.actions].sort().join(",");
  return `specific:${sorted}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (
      !deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}
