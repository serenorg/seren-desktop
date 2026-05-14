// ABOUTME: Unified approval inbox service - wraps the generated /inbox/approvals SDK calls.
// ABOUTME: Component code consumes typed entries from here so the generated SDK union stays load-bearing.

import {
  type ApprovalDecisionState,
  type ApprovalInboxDecisionRequest,
  type ApprovalInboxDecisionResponse,
  type ApprovalInboxDecisionVerb,
  type ApprovalInboxEntry,
  type ApprovalInboxListResponse,
  serenCloudApprovalInboxDecide,
  serenCloudApprovalInboxList,
} from "@/api/seren-cloud";
import { formatApiError } from "@/lib/api-errors";

export type {
  ApprovalDecisionState,
  ApprovalInboxDecisionResponse,
  ApprovalInboxEntry,
  ApprovalInboxListResponse,
};

export type ApprovalDecisionVerb = ApprovalInboxDecisionVerb;

export type ApprovalInboxToolCallEntry = Extract<
  ApprovalInboxEntry,
  { kind: "tool_call" }
>;
export type ApprovalInboxBlockedEgressEntry = Extract<
  ApprovalInboxEntry,
  { kind: "blocked_egress" }
>;
export type ApprovalInboxOtherEntry = Extract<
  ApprovalInboxEntry,
  { kind: "other" }
>;

export interface ApprovalInboxListQuery {
  limit?: number;
  cursor?: string;
}

export interface ApprovalInboxDecisionInput {
  decision: ApprovalDecisionVerb;
  comment?: string;
}

/**
 * Thrown when the backend returns 501 for a blocked-egress decide call.
 * The audit row is still written upstream; the runtime release plumbing is
 * the missing piece. Callers surface this as an operator-readable notice.
 */
export class ApprovalInboxNotImplementedError extends Error {
  readonly entryId: string;
  constructor(entryId: string, message: string) {
    super(message);
    this.name = "ApprovalInboxNotImplementedError";
    this.entryId = entryId;
  }
}

function organizationHeader(organizationId: string): Record<string, string> {
  // The Gateway scopes inbox results by the auth token's org; including the
  // header lets us assert in tests and matches the established service layer.
  return {
    "x-organization-id": organizationId,
  };
}

export const approvalInbox = {
  async list(
    organizationId: string,
    query: ApprovalInboxListQuery = {},
  ): Promise<ApprovalInboxListResponse> {
    const queryParams: Record<string, string | number> = {};
    if (typeof query.limit === "number") {
      queryParams.limit = query.limit;
    }
    if (typeof query.cursor === "string" && query.cursor.length > 0) {
      queryParams.cursor = query.cursor;
    }
    const { data, error, response } = await serenCloudApprovalInboxList({
      query: queryParams,
      headers: organizationHeader(organizationId),
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to list approval inbox: ${formatApiError(error, response, "")}`,
      );
    }
    return data?.data ?? { entries: [] };
  },

  async decide(
    organizationId: string,
    entryId: string,
    input: ApprovalInboxDecisionInput,
  ): Promise<ApprovalInboxDecisionResponse> {
    const body: ApprovalInboxDecisionRequest = {
      decision: input.decision,
      ...(input.comment !== undefined && input.comment !== ""
        ? { comment: input.comment }
        : {}),
    };
    const { data, error, response } = await serenCloudApprovalInboxDecide({
      path: { entry_id: entryId },
      body,
      headers: organizationHeader(organizationId),
      throwOnError: false,
    });
    if (error) {
      if (response?.status === 501) {
        throw new ApprovalInboxNotImplementedError(
          entryId,
          "Decision recorded in audit, but runtime release for blocked egress is not implemented yet.",
        );
      }
      throw new Error(
        `Failed to record decision: ${formatApiError(error, response, "")}`,
      );
    }
    if (!data?.data) {
      throw new Error(
        "Approval inbox decision response did not include a body",
      );
    }
    return data.data;
  },
};
