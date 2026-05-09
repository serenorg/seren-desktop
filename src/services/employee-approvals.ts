// ABOUTME: Cross-deployment approval inbox - powers the sidebar badge for awaiting runs.
// ABOUTME: Reads /pending_approvals from seren-cloud and groups awaiting runs by deployment id.

import {
  type CloudPendingApprovalRun,
  serenCloudPendingApprovals,
} from "@/api/seren-cloud";
import { formatApiError } from "@/lib/api-errors";

export type OrgPendingApprovalRun = {
  runId: string;
  deploymentId: string;
  runName: string | null;
  source: string;
  status: string;
  startedAt: string;
  statusMessage: string | null;
  pendingCount: number;
};

function fromCloud(row: CloudPendingApprovalRun): OrgPendingApprovalRun {
  return {
    runId: row.run_id,
    deploymentId: row.deployment_id,
    runName: row.run_name ?? null,
    source: row.source,
    status: row.status,
    startedAt: row.started_at,
    statusMessage: row.status_message ?? null,
    pendingCount: row.pending_approvals?.length ?? 0,
  };
}

export const employeeApprovals = {
  async listOrg(limit = 100): Promise<OrgPendingApprovalRun[]> {
    const { data, error, response } = await serenCloudPendingApprovals({
      query: { limit },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to load pending approvals: ${formatApiError(error, response, "")}`,
      );
    }
    return (data?.data ?? []).map(fromCloud);
  },

  groupByDeployment(
    rows: OrgPendingApprovalRun[],
  ): Map<string, OrgPendingApprovalRun[]> {
    const out = new Map<string, OrgPendingApprovalRun[]>();
    for (const row of rows) {
      const list = out.get(row.deploymentId) ?? [];
      list.push(row);
      out.set(row.deploymentId, list);
    }
    return out;
  },
};
