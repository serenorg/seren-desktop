// ABOUTME: Eval-gate editor service - updates EvalGate config (set/max age/block/schedule).

import {
  type AgentSpecUpdate,
  type EvalGateSchedule,
  type EvalGate as GeneratedEvalGate,
  serenAgentUpdateManagedDeployment,
} from "@/api/seren-agent";
import { formatApiError } from "@/lib/api-errors";

export type EvalGateWithSchedule = GeneratedEvalGate;

export interface EvalGateInput {
  set_id: string;
  max_age_seconds: number;
  block_on_failure?: boolean | null;
  // null means "drop any existing schedule"; undefined means "do not touch".
  schedule?: EvalGateSchedule | null;
}

const CRON_FIELD_RE = /^\S+$/;

export function validateCronExpression(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Cron expression is required.";
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return "Cron expression must have exactly 5 fields (minute hour day month weekday).";
  }
  for (const part of parts) {
    if (!CRON_FIELD_RE.test(part)) {
      return "Cron fields cannot be empty.";
    }
  }
  return null;
}

export async function updateEvalGate(
  deploymentId: string,
  gate: EvalGateInput,
): Promise<void> {
  const body: AgentSpecUpdate = {
    eval_gate: gate,
  };
  const { error, response } = await serenAgentUpdateManagedDeployment({
    path: { id: deploymentId },
    body,
    throwOnError: false,
  });
  if (error) {
    throw new Error(
      `Failed to update eval gate: ${formatApiError(error, response, "")}`,
    );
  }
}

export async function clearEvalGate(deploymentId: string): Promise<void> {
  const body: AgentSpecUpdate = { clear_eval_gate: true };
  const { error, response } = await serenAgentUpdateManagedDeployment({
    path: { id: deploymentId },
    body,
    throwOnError: false,
  });
  if (error) {
    throw new Error(
      `Failed to clear eval gate: ${formatApiError(error, response, "")}`,
    );
  }
}
