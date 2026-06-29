import { validate as isUuid } from "uuid";

export interface SerenSecretsReference {
  vaultId: string;
  itemId: string;
  field: string;
}

export interface CredentialReferenceLike {
  ref_uri: string;
  binding?: string | null;
}

export interface ParsedCredentialReferenceLine {
  name: string;
  ref_uri: string;
}

export type CredentialReferenceLineParseResult =
  | { refs: ParsedCredentialReferenceLine[]; error: null }
  | { refs: []; error: string };

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function isCanonicalUuid(value: string): boolean {
  return isUuid(value) && value.toLowerCase() !== NIL_UUID;
}

export function isEnvVarName(name: string): boolean {
  return /^[_A-Z][_A-Z0-9]*$/.test(name.trim().toUpperCase());
}

export function credentialNameForField(fieldName: string): string {
  const normalized = fieldName
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!normalized) return "SECRET";
  if (/^[A-Z_]/.test(normalized)) return normalized;
  return `SECRET_${normalized}`;
}

export function formatSerenSecretsReference(
  ref: SerenSecretsReference,
): string {
  return `seren-secrets://${ref.vaultId}/${ref.itemId}/${ref.field}`;
}

export function parseSerenSecretsReference(
  value: string,
): SerenSecretsReference | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "seren-secrets:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !isCanonicalUuid(parsed.hostname)
  ) {
    return null;
  }

  const pathSegments = parsed.pathname.split("/");
  if (
    pathSegments.length !== 3 ||
    pathSegments[0] !== "" ||
    !isCanonicalUuid(pathSegments[1] ?? "") ||
    !(pathSegments[2] ?? "")
  ) {
    return null;
  }

  // UUIDs are case-insensitive; normalize both IDs to canonical lowercase so a
  // valid uppercase UUID resolves against canonical-lowercase stored ids. (The
  // URL parser already lowercases the host, but the path segment is not.)
  return {
    vaultId: parsed.hostname.toLowerCase(),
    itemId: pathSegments[1].toLowerCase(),
    field: pathSegments[2],
  };
}

export function isSerenSecretsReference(value: string): boolean {
  return parseSerenSecretsReference(value) !== null;
}

export function buildSerenSecretsFieldReferences(
  vaultId: string,
  itemId: string,
  fieldNames: readonly string[],
): Record<string, string> {
  const references: Record<string, string> = {};
  for (const field of fieldNames) {
    const name = field.trim();
    if (!name || !isEnvVarName(name)) continue;
    references[name.toUpperCase()] = formatSerenSecretsReference({
      vaultId,
      itemId,
      field: name,
    });
  }
  return references;
}

export function parseCredentialReferenceLines(
  value: string,
): CredentialReferenceLineParseResult {
  const refs: ParsedCredentialReferenceLine[] = [];
  const lines = value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { refs: [], error: "Add at least one credential reference." };
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return {
        refs: [],
        error: `Line ${index + 1} must use NAME=seren-secrets://vault/item/field.`,
      };
    }

    const name = line.slice(0, separator).trim();
    const refUri = line.slice(separator + 1).trim();
    if (!isEnvVarName(name)) {
      return {
        refs: [],
        error: `Line ${index + 1} has an invalid environment variable name.`,
      };
    }
    if (!isSerenSecretsReference(refUri)) {
      return {
        refs: [],
        error: `Line ${index + 1} must use a valid seren-secrets://vault/item/field reference.`,
      };
    }

    refs.push({
      name: name.toUpperCase(),
      ref_uri: refUri,
    });
  }

  return { refs, error: null };
}

export function uniqueVaultIdsFromCredentialRefs(
  refs: readonly CredentialReferenceLike[],
): string[] {
  const vaultIds = new Set<string>();
  for (const ref of refs) {
    const parsed = parseSerenSecretsReference(ref.ref_uri);
    if (parsed) vaultIds.add(parsed.vaultId);
  }
  return Array.from(vaultIds);
}

export function uniqueSerenSecretCredentialRefs(
  refs: readonly CredentialReferenceLike[],
): SerenSecretsReference[] {
  const parsed = new Map<string, SerenSecretsReference>();
  for (const ref of refs) {
    const value = parseSerenSecretsReference(ref.ref_uri);
    if (!value) continue;
    parsed.set(`${value.vaultId}/${value.itemId}/${value.field}`, value);
  }
  return Array.from(parsed.values()).sort((left, right) =>
    formatSerenSecretsReference(left).localeCompare(
      formatSerenSecretsReference(right),
    ),
  );
}

export function credentialRefLabel(ref: CredentialReferenceLike): string {
  if (ref.ref_uri.startsWith("seren-secrets://")) {
    return ref.binding === "proxy_inject"
      ? "Seren Secrets item field"
      : "Seren Secrets credential";
  }
  if (ref.ref_uri.startsWith("org-secret://")) {
    return "Organization secret";
  }
  if (ref.ref_uri.startsWith("user-secret://")) {
    return "User secret";
  }
  if (ref.ref_uri.startsWith("control-plane://")) {
    return "Connected provider";
  }
  return "Credential reference";
}
