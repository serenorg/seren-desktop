// ABOUTME: Session-checkpoint service - lists and reads operator-only session checkpoints.
// ABOUTME: Uses the raw client because these admin endpoints are hidden from the public SDK.

import { client } from "@/api/seren-cloud";
import { formatApiError } from "@/lib/api-errors";

export interface SessionCheckpoint {
  checkpoint_id: string;
  id?: string;
  organization_id?: string;
  deployment_id: string;
  session_id: string;
  sequence_number: number;
  reason: string;
  iteration_count: number;
  tool_call_state?: unknown;
  conversation_state_ref?: unknown;
  last_compaction_at?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface SessionCheckpointHydrated extends SessionCheckpoint {
  conversation_state?: unknown;
}

export interface SessionCheckpointListResponse {
  entries: SessionCheckpoint[];
  next_cursor?: string | null;
}

export interface SessionCheckpointListQuery {
  limit?: number;
  cursor?: string;
}

function organizationHeader(organizationId: string): Record<string, string> {
  return { "x-organization-id": organizationId };
}

interface SessionCheckpointWire {
  id?: string;
  checkpoint_id?: string;
  organization_id?: string;
  deployment_id: string;
  session_id: string;
  sequence_number: number;
  reason: string;
  iteration_count: number;
  tool_call_state?: unknown;
  conversation_state_ref?: unknown;
  conversation_state?: unknown;
  last_compaction_at?: string | null;
  created_at: string;
  updated_at?: string;
}

type ListResponses = {
  200: {
    data: {
      entries: SessionCheckpointWire[];
      next_cursor?: string | null;
    };
  };
};
type LatestResponses = { 200: { data: SessionCheckpointWire } };

function normalizeCheckpoint(
  row: SessionCheckpointWire,
): SessionCheckpointHydrated {
  const checkpointId = row.checkpoint_id ?? row.id;
  if (!checkpointId) {
    throw new Error("Session checkpoint response did not include an id");
  }
  return {
    checkpoint_id: checkpointId,
    ...(row.id !== undefined ? { id: row.id } : {}),
    ...(row.organization_id !== undefined
      ? { organization_id: row.organization_id }
      : {}),
    deployment_id: row.deployment_id,
    session_id: row.session_id,
    sequence_number: row.sequence_number,
    reason: row.reason,
    iteration_count: row.iteration_count,
    ...(row.tool_call_state !== undefined
      ? { tool_call_state: row.tool_call_state }
      : {}),
    ...(row.conversation_state_ref !== undefined
      ? { conversation_state_ref: row.conversation_state_ref }
      : {}),
    ...(row.conversation_state !== undefined
      ? { conversation_state: row.conversation_state }
      : {}),
    ...(row.last_compaction_at !== undefined
      ? { last_compaction_at: row.last_compaction_at }
      : {}),
    created_at: row.created_at,
    ...(row.updated_at !== undefined ? { updated_at: row.updated_at } : {}),
  };
}

export const sessionCheckpoints = {
  async list(
    organizationId: string,
    deploymentId: string,
    query: SessionCheckpointListQuery = {},
  ): Promise<SessionCheckpointListResponse> {
    const queryParams: Record<string, string | number> = {};
    if (typeof query.limit === "number") {
      queryParams.limit = query.limit;
    }
    if (typeof query.cursor === "string" && query.cursor.length > 0) {
      queryParams.cursor = query.cursor;
    }
    const { data, error, response } = await client.get<
      ListResponses,
      unknown,
      false
    >({
      url: "/deployments/{id}/session-checkpoints",
      path: { id: deploymentId },
      query: queryParams,
      headers: organizationHeader(organizationId),
      security: [{ scheme: "bearer", type: "http" }],
      throwOnError: false,
    });
    if (error) {
      const status = response?.status ?? 0;
      if (status === 404) {
        throw new Error(
          "Session checkpoints unavailable: deployment not found.",
        );
      }
      throw new Error(
        `Failed to list session checkpoints: ${formatApiError(error, response, "")}`,
      );
    }
    const page = data?.data;
    if (!page) return { entries: [] };
    return {
      entries: page.entries.map(normalizeCheckpoint),
      next_cursor: page.next_cursor,
    };
  },

  async latest(
    organizationId: string,
    deploymentId: string,
    sessionId: string,
  ): Promise<SessionCheckpointHydrated | null> {
    const { data, error, response } = await client.get<
      LatestResponses,
      unknown,
      false
    >({
      url: "/deployments/{id}/sessions/{session_id}/checkpoints/latest",
      path: { id: deploymentId, session_id: sessionId },
      headers: organizationHeader(organizationId),
      security: [{ scheme: "bearer", type: "http" }],
      throwOnError: false,
    });
    if (error) {
      const status = response?.status ?? 0;
      if (status === 404) return null;
      throw new Error(
        `Failed to load latest checkpoint: ${formatApiError(error, response, "")}`,
      );
    }
    return data?.data ? normalizeCheckpoint(data.data) : null;
  },
};
