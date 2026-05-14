// ABOUTME: Eval-drift service - wraps GET /deployments/{id}/eval-drift for operator UI.

import {
  type CloudDeploymentEvalDrift,
  serenCloudGetDeploymentEvalDrift,
} from "@/api/seren-cloud";
import { formatApiError } from "@/lib/api-errors";

export type { CloudDeploymentEvalDrift };

export async function getEvalDrift(
  organizationId: string,
  deploymentId: string,
): Promise<CloudDeploymentEvalDrift> {
  const { data, error, response } = await serenCloudGetDeploymentEvalDrift({
    path: { id: deploymentId },
    headers: { "x-organization-id": organizationId },
    throwOnError: false,
  });
  if (error) {
    const status = response?.status ?? 0;
    if (status === 404) {
      throw new Error(
        "Eval drift unavailable: deployment not found or no eval gate attached.",
      );
    }
    if (status === 400) {
      throw new Error(
        `Eval drift unavailable: ${formatApiError(error, response, "bad request")}`,
      );
    }
    throw new Error(
      `Failed to load eval drift: ${formatApiError(error, response, "")}`,
    );
  }
  if (!data?.data) {
    throw new Error("Eval drift response did not include a body");
  }
  return data.data;
}
