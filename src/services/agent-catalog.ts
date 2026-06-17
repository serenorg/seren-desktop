// ABOUTME: Agent catalog service - thin wrapper around the generated seren-core SDK.
// ABOUTME: Components and stores never call the SDK directly; they go through this module.

import {
  type AgentCatalogEntry,
  type AgentCatalogEntryCreateRequest,
  type AgentCatalogEntryKind,
  type AgentCatalogEntryUpdateRequest,
  createCatalogEntry,
  deleteCatalogEntry,
  getCatalogEntry,
  listCatalogEntries,
  resolveCatalogTag,
  updateCatalogEntry,
} from "@/api";
import { formatApiError } from "@/lib/api-errors";

export type CatalogEntry = AgentCatalogEntry;
export type CatalogEntryKind = AgentCatalogEntryKind;
export type CatalogCreateRequest = AgentCatalogEntryCreateRequest;
export type CatalogUpdateRequest = AgentCatalogEntryUpdateRequest;

export type CatalogListQuery = {
  namespace?: string;
  kind?: CatalogEntryKind;
  name?: string;
  tag?: string;
  includeDeprecated?: boolean;
};

const CATALOG_ENTRY_KINDS: CatalogEntryKind[] = [
  "agent",
  "skill",
  "mcp_server",
  "prompt",
  "runtime_policy",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalStringField(
  obj: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function catalogKind(value: unknown): CatalogEntryKind | null {
  return typeof value === "string" &&
    CATALOG_ENTRY_KINDS.includes(value as CatalogEntryKind)
    ? (value as CatalogEntryKind)
    : null;
}

export function normalizeAgentCatalogEntry(
  value: unknown,
): CatalogEntry | null {
  if (!isRecord(value)) return null;

  const id = stringField(value, "id");
  const name = stringField(value, "name");
  const version = stringField(value, "version");
  const kind = catalogKind(value.kind);

  if (!id || !name || !version || !kind) {
    return null;
  }

  return {
    annotations: value.annotations ?? {},
    category: optionalStringField(value, "category") ?? null,
    created_at: stringField(value, "created_at") ?? "",
    created_by_user_id: optionalStringField(value, "created_by_user_id"),
    deprecated: value.deprecated === true,
    description: typeof value.description === "string" ? value.description : "",
    id,
    kind,
    labels: value.labels ?? {},
    name,
    namespace: stringField(value, "namespace") ?? "default",
    organization_id: stringField(value, "organization_id") ?? "",
    requires: isRecord(value.requires)
      ? (value.requires as CatalogEntry["requires"])
      : undefined,
    source: value.source ?? { type: "inline" },
    tag: optionalStringField(value, "tag") ?? null,
    trust: value.trust ?? {},
    updated_at: stringField(value, "updated_at") ?? "",
    version,
  };
}

export function normalizeAgentCatalogEntries(value: unknown): CatalogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const normalized = normalizeAgentCatalogEntry(entry);
    return normalized ? [normalized] : [];
  });
}

function requireCatalogEntry(value: unknown, action: string): CatalogEntry {
  const entry = normalizeAgentCatalogEntry(value);
  if (!entry) {
    throw new Error(`Catalog ${action} response did not include a valid entry`);
  }
  return entry;
}

export const agentCatalog = {
  async list(
    organizationId: string,
    query: CatalogListQuery = {},
  ): Promise<CatalogEntry[]> {
    const { data, error, response } = await listCatalogEntries({
      path: { organization_id: organizationId },
      query: {
        namespace: query.namespace,
        kind: query.kind,
        name: query.name,
        tag: query.tag,
        include_deprecated: query.includeDeprecated,
      },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to list catalog entries: ${formatApiError(error, response, "")}`,
      );
    }
    return normalizeAgentCatalogEntries(data?.data?.data);
  },

  async get(organizationId: string, entryId: string): Promise<CatalogEntry> {
    const { data, error, response } = await getCatalogEntry({
      path: { organization_id: organizationId, entry_id: entryId },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to load catalog entry: ${formatApiError(error, response, "")}`,
      );
    }
    return requireCatalogEntry(data?.data, "load");
  },

  async resolveTag(
    organizationId: string,
    namespace: string,
    name: string,
    tag: string,
  ): Promise<CatalogEntry> {
    const { data, error, response } = await resolveCatalogTag({
      path: {
        organization_id: organizationId,
        namespace,
        name,
        tag,
      },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to resolve catalog tag: ${formatApiError(error, response, "")}`,
      );
    }
    return requireCatalogEntry(data?.data, "tag-resolution");
  },

  async create(
    organizationId: string,
    request: CatalogCreateRequest,
  ): Promise<CatalogEntry> {
    const { data, error, response } = await createCatalogEntry({
      path: { organization_id: organizationId },
      body: request,
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to create catalog entry: ${formatApiError(error, response, "")}`,
      );
    }
    return requireCatalogEntry(data?.data, "create");
  },

  async update(
    organizationId: string,
    entryId: string,
    request: CatalogUpdateRequest,
  ): Promise<CatalogEntry> {
    const { data, error, response } = await updateCatalogEntry({
      path: { organization_id: organizationId, entry_id: entryId },
      body: request,
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to update catalog entry: ${formatApiError(error, response, "")}`,
      );
    }
    return requireCatalogEntry(data?.data, "update");
  },

  async delete(organizationId: string, entryId: string): Promise<void> {
    const { error, response } = await deleteCatalogEntry({
      path: { organization_id: organizationId, entry_id: entryId },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to delete catalog entry: ${formatApiError(error, response, "")}`,
      );
    }
  },
};
