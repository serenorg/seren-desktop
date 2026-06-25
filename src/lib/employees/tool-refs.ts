// ABOUTME: Small typed-tool authoring helpers for managed employee forms.
// ABOUTME: Keeps connector presets as AgentToolRef data instead of prompt text.

import type { AgentToolRef } from "@/api/seren-agent";

export type ConnectorAccessMode = "none" | "gmail_read" | "gmail_send_approval";
export type RemoteHttpToolRef = Extract<AgentToolRef, { kind: "remote_http" }>;
export type PublisherToolRef = Extract<AgentToolRef, { kind: "publisher" }>;

export type PublisherOperationOption = Pick<
  PublisherToolRef,
  "publisher_slug" | "operation_id" | "require_approval"
> & {
  title: string;
  sub: string;
};

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

export const PUBLISHER_OPERATION_OPTIONS: PublisherOperationOption[] = [
  {
    publisher_slug: "microsoft",
    operation_id: "calendar.events.list",
    title: "Microsoft calendar read",
    sub: "Read calendar events",
  },
  {
    publisher_slug: "microsoft",
    operation_id: "mail.messages.list",
    title: "Microsoft mail read",
    sub: "Read mailbox messages",
  },
  {
    publisher_slug: "microsoft",
    operation_id: "mail.messages.send",
    title: "Microsoft mail send",
    sub: "Send mail with approval",
    require_approval: true,
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

export function firstRemoteHttpToolRef(
  refs: readonly AgentToolRef[],
): RemoteHttpToolRef | undefined {
  return refs.find(
    (ref): ref is RemoteHttpToolRef => ref.kind === "remote_http",
  );
}

export function mergeRemoteHttpToolRef(
  existing: readonly AgentToolRef[],
  remoteHttp: RemoteHttpToolRef | undefined,
): AgentToolRef[] {
  let replaced = false;
  const refs: AgentToolRef[] = [];
  for (const ref of existing) {
    if (ref.kind === "remote_http" && !replaced) {
      replaced = true;
      if (remoteHttp) refs.push(remoteHttp);
    } else {
      refs.push(ref);
    }
  }
  if (!replaced && remoteHttp) refs.push(remoteHttp);
  return refs;
}

function publisherOperationKey(
  ref: Pick<PublisherToolRef, "publisher_slug" | "operation_id">,
) {
  return `${ref.publisher_slug}:${ref.operation_id}`;
}

export function selectedPublisherOperationKeysFromToolRefs(
  refs: readonly AgentToolRef[],
): string[] {
  const known = new Set(
    PUBLISHER_OPERATION_OPTIONS.map((option) => publisherOperationKey(option)),
  );
  return refs
    .filter((ref): ref is PublisherToolRef => ref.kind === "publisher")
    .map(publisherOperationKey)
    .filter((key) => known.has(key));
}

export function mergePublisherOperationToolRefs(
  existing: readonly AgentToolRef[],
  selectedKeys: readonly string[],
): AgentToolRef[] {
  const formOwnedKeys = new Set(
    PUBLISHER_OPERATION_OPTIONS.map((option) => publisherOperationKey(option)),
  );
  const selected = new Set(selectedKeys);
  const refs = existing.filter(
    (ref) =>
      ref.kind !== "publisher" ||
      !formOwnedKeys.has(publisherOperationKey(ref)),
  );

  for (const option of PUBLISHER_OPERATION_OPTIONS) {
    const key = publisherOperationKey(option);
    if (!selected.has(key)) continue;
    refs.push({
      kind: "publisher",
      publisher_slug: option.publisher_slug,
      operation_id: option.operation_id,
      require_approval: option.require_approval ?? false,
      permitted_actions: [
        {
          action: option.operation_id,
          capability: { kind: "all" },
        },
      ],
    });
  }

  return refs;
}

export function remoteHttpToolRefDraftError(input: {
  enabled: boolean;
  name: string;
  endpoint: string;
  method?: RemoteHttpToolRef["method"];
  existingRefs?: readonly AgentToolRef[];
  editingRef?: RemoteHttpToolRef;
}): string {
  if (!input.enabled) return "";
  const nameError = remoteHttpNameDraftError(input.name);
  if (nameError) return nameError;
  const endpoint = input.endpoint.trim();
  if (endpoint.length === 0) return "Remote HTTP endpoint is required.";
  try {
    const url = new URL(endpoint);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname.length === 0
    ) {
      return "Remote HTTP endpoint must be an HTTP(S) URL.";
    }
    if (url.protocol === "http:") {
      return "Remote HTTP endpoint must use HTTPS.";
    }
    if (url.username || url.password) {
      return "Remote HTTP endpoint must not include credentials.";
    }
    if (isBlockedRemoteHttpHost(url.hostname)) {
      return "Remote HTTP endpoint must not target localhost or private IPs.";
    }
    if (endpoint.includes("#")) {
      return "Remote HTTP endpoint must not include a fragment.";
    }
    const duplicateError = duplicateRemoteHttpDraftError({
      name: input.name,
      endpoint,
      method: input.method ?? "post",
      existingRefs: input.existingRefs ?? [],
      editingRef: input.editingRef,
    });
    if (duplicateError) return duplicateError;
  } catch {
    return "Remote HTTP endpoint must be a valid URL.";
  }
  return "";
}

function remoteHttpNameDraftError(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Remote HTTP name is required.";
  if (trimmed !== name) {
    return "Remote HTTP name must not include leading or trailing whitespace.";
  }
  if (trimmed.length > 128) {
    return "Remote HTTP name must be at most 128 characters.";
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return "Remote HTTP name may only contain letters, numbers, underscores, dashes, and dots.";
  }
  return "";
}

function duplicateRemoteHttpDraftError(input: {
  name: string;
  endpoint: string;
  method: RemoteHttpToolRef["method"];
  existingRefs: readonly AgentToolRef[];
  editingRef?: RemoteHttpToolRef;
}): string {
  const name = input.name.trim();
  const endpointKey = remoteHttpEndpointIdentityKey(
    input.method,
    input.endpoint,
  );
  for (const ref of input.existingRefs) {
    if (ref.kind !== "remote_http") continue;
    if (input.editingRef && sameToolRef(ref, input.editingRef)) continue;
    if (ref.name.trim() === name) return "Remote HTTP name already exists.";
    if (
      remoteHttpEndpointIdentityKey(ref.method, ref.endpoint) === endpointKey
    ) {
      return "Remote HTTP endpoint already exists for this method.";
    }
  }
  return "";
}

function remoteHttpEndpointIdentityKey(
  method: RemoteHttpToolRef["method"],
  endpoint: string,
): string {
  try {
    const url = new URL(endpoint.trim());
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    url.hostname = url.hostname.toLowerCase();
    return `${method}:${url.toString()}`;
  } catch {
    return `${method}:${endpoint.trim()}`;
  }
}

function isBlockedRemoteHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "localhost.") return true;

  const ipv4 = parseIpv4Literal(host);
  if (ipv4) return isBlockedIpv4(ipv4);

  const ipv6 = parseIpv6Literal(host);
  if (!ipv6) return false;

  if (ipv6.every((segment) => segment === 0)) return true;
  if (ipv6.slice(0, 7).every((segment) => segment === 0) && ipv6[7] === 1) {
    return true;
  }
  if ((ipv6[0] & 0xfe00) === 0xfc00) return true;
  if ((ipv6[0] & 0xffc0) === 0xfe80) return true;
  if (ipv6[0] === 0x2001 && ipv6[1] === 0x0db8) return true;

  const mappedIpv4 = ipv4FromIpv6(ipv6);
  return mappedIpv4 ? isBlockedIpv4(mappedIpv4) : false;
}

function parseIpv4Literal(
  host: string,
): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255 ||
        String(octet) !== parts[index],
    )
  ) {
    return null;
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function isBlockedIpv4([a, b, c, d]: [
  number,
  number,
  number,
  number,
]): boolean {
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function parseIpv6Literal(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const pieces = host.split("::");
  if (pieces.length > 2) return null;

  const left = parseIpv6Side(pieces[0]);
  const right = pieces.length === 2 ? parseIpv6Side(pieces[1]) : [];
  if (!left || !right) return null;

  if (pieces.length === 1) {
    return left.length === 8 ? left : null;
  }

  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) return null;
  return [...left, ...Array(zeroCount).fill(0), ...right];
}

function parseIpv6Side(value: string): number[] | null {
  if (value.length === 0) return [];
  return value
    .split(":")
    .map((part) => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return Number.NaN;
      return Number.parseInt(part, 16);
    })
    .every(
      (segment) =>
        Number.isInteger(segment) && segment >= 0 && segment <= 0xffff,
    )
    ? value.split(":").map((part) => Number.parseInt(part, 16))
    : null;
}

function ipv4FromIpv6(
  segments: number[],
): [number, number, number, number] | null {
  const isCompatible = segments.slice(0, 6).every((segment) => segment === 0);
  const isMapped =
    segments.slice(0, 5).every((segment) => segment === 0) &&
    segments[5] === 0xffff;
  if (!isCompatible && !isMapped) return null;
  return [
    segments[6] >> 8,
    segments[6] & 0xff,
    segments[7] >> 8,
    segments[7] & 0xff,
  ];
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
    case "remote_http": {
      if (b.kind !== "remote_http") return false;
      return (
        a.name === b.name &&
        a.endpoint === b.endpoint &&
        a.method === b.method &&
        a.auth_mode === b.auth_mode &&
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

function sameOptionalBool(
  a: boolean | null | undefined,
  b: boolean | null | undefined,
) {
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
