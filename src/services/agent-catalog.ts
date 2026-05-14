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
    return data?.data?.data ?? [];
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
    if (!data?.data) {
      throw new Error("Catalog entry response did not include a body");
    }
    return data.data;
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
    if (!data?.data) {
      throw new Error("Catalog tag-resolution response did not include a body");
    }
    return data.data;
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
    if (!data?.data) {
      throw new Error("Catalog create response did not include a body");
    }
    return data.data;
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
    if (!data?.data) {
      throw new Error("Catalog update response did not include a body");
    }
    return data.data;
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
