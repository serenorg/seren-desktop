// ABOUTME: Builds compact employee deployment review copy for create/edit UI.
// ABOUTME: Summarizes policy and access DTOs without changing AgentSpec payloads.

import type {
  AgentGuardrailPolicy,
  AgentRuntimePolicy,
  AgentToolRef,
  ManagedAgentApprovalPolicy,
  ManagedAgentToolPreset,
} from "@/api/seren-agent";

export type EmployeePolicyReviewSummary = {
  runtimePolicy: string[];
  toolAccess: string[];
  toolRefDetails: string[];
  approvalRules: string[];
};

export type EmployeePolicyReviewInput = {
  approvalPolicy: ManagedAgentApprovalPolicy;
  toolPresets: readonly ManagedAgentToolPreset[];
  runtimePolicy?: AgentRuntimePolicy | null;
  toolRefs?: readonly AgentToolRef[];
  guardrails?: readonly AgentGuardrailPolicy[];
};

const TOOL_PRESET_LABELS: Record<ManagedAgentToolPreset, string> = {
  live_data: "Live data",
  publisher_actions: "Publisher actions",
  database: "Database",
};

const APPROVAL_POLICY_LABELS: Record<ManagedAgentApprovalPolicy, string> = {
  read_only: "Read-only by default",
  allow_mutations: "Mutation-capable tools allowed",
};

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function compactList(items: readonly string[], empty: string, limit = 4) {
  if (items.length === 0) return empty;
  const shown = items.slice(0, limit).join(", ");
  const remaining = items.length - limit;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function clipText(value: string, maxLength: number) {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}

function formatRemoteHttpEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return clipText(url.host, 64);
  } catch {
    return "custom endpoint";
  }
}

function formatToolPreset(preset: ManagedAgentToolPreset) {
  return TOOL_PRESET_LABELS[preset] ?? preset;
}

function formatActionLeases(ref: AgentToolRef) {
  const leases =
    "permitted_actions" in ref ? (ref.permitted_actions ?? []) : [];
  if (leases.length === 0) return "no per-action leases";
  return compactList(
    leases.map((lease) =>
      lease.capability.kind === "all"
        ? `${lease.action}: all`
        : `${lease.action}: ${lease.capability.actions.join(", ")}`,
    ),
    "no per-action leases",
  );
}

function formatToolRef(ref: AgentToolRef) {
  switch (ref.kind) {
    case "publisher":
      return `Publisher ${ref.publisher_slug}/${ref.operation_id}`;
    case "mcp":
      return `MCP ${ref.server_ref}/${ref.tool_name}`;
    case "connector":
      return `Connector ${ref.connector_ref} (${ref.capability})`;
    case "remote_agent":
      return `Remote agent ${ref.origin}`;
    case "remote_http":
      return `Remote HTTP ${ref.method.toUpperCase()} ${clipText(ref.name, 48)}`;
    case "preset_group":
      return `Preset ${formatToolPreset(ref.preset)}`;
    default:
      return `Unknown tool ref ${clipText(
        (ref as { kind?: string }).kind ?? "unknown",
        48,
      )}`;
  }
}

function runtimePolicyLines(policy: AgentRuntimePolicy | null | undefined) {
  if (!policy) {
    return ["Default managed runtime policy"];
  }

  const lines = [`Schema v${policy.version}`];
  if (policy.runtime_class) lines.push(`Runtime class ${policy.runtime_class}`);
  if (policy.network) {
    const egressRules = policy.network.egress_rules ?? [];
    const inbox = policy.network.blocked_request_inbox
      ? "; blocked egress inbox on"
      : "";
    lines.push(
      `Network default ${policy.network.default ?? "unset"}; ${plural(
        egressRules.length,
        "egress rule",
      )}${inbox}`,
    );
  }
  if (policy.filesystem) {
    const readOnly = policy.filesystem.read_only_paths ?? [];
    const readWrite = policy.filesystem.read_write_paths ?? [];
    lines.push(
      `Filesystem ${policy.filesystem.enforcement ?? "default"}; ${plural(
        readOnly.length,
        "read-only path",
      )}; ${plural(readWrite.length, "read-write path")}`,
    );
  }
  if (policy.process) {
    const processParts = [
      policy.process.no_new_privileges ? "no new privileges" : null,
      policy.process.run_as_user ? `user ${policy.process.run_as_user}` : null,
      policy.process.capability_drop
        ? `drops ${policy.process.capability_drop.join(", ")}`
        : null,
      policy.process.seccomp_profile
        ? `seccomp ${policy.process.seccomp_profile}`
        : null,
    ].filter((part): part is string => Boolean(part));
    lines.push(compactList(processParts, "Process policy declared"));
  }
  if (policy.resources) {
    const resourceParts = [
      policy.resources.cpu_request
        ? `CPU request ${policy.resources.cpu_request}`
        : null,
      policy.resources.cpu_limit
        ? `CPU limit ${policy.resources.cpu_limit}`
        : null,
      policy.resources.memory_request
        ? `memory request ${policy.resources.memory_request}`
        : null,
      policy.resources.memory_limit
        ? `memory limit ${policy.resources.memory_limit}`
        : null,
      policy.resources.max_runtime_seconds
        ? `runtime cap ${policy.resources.max_runtime_seconds}s`
        : null,
      policy.resources.max_tool_calls
        ? `tool cap ${policy.resources.max_tool_calls}`
        : null,
    ].filter((part): part is string => Boolean(part));
    lines.push(compactList(resourceParts, "Resource policy declared"));
  }

  return lines;
}

function toolRefDetailLines(toolRefs: readonly AgentToolRef[]) {
  if (toolRefs.length === 0) {
    return ["No typed tool refs declared"];
  }
  return toolRefs.map((ref) => {
    const approval =
      "require_approval" in ref && ref.require_approval
        ? "; requires approval"
        : "";
    const scopes =
      ref.kind === "connector"
        ? `; scopes: ${compactList(ref.scopes ?? [], "none")}`
        : "";
    const endpoint =
      ref.kind === "remote_http"
        ? `; endpoint ${formatRemoteHttpEndpoint(ref.endpoint)}`
        : "";
    return `${formatToolRef(ref)}${endpoint}${scopes}; ${formatActionLeases(ref)}${approval}`;
  });
}

export function buildEmployeePolicyReviewSummary(
  input: EmployeePolicyReviewInput,
): EmployeePolicyReviewSummary {
  const toolRefs = input.toolRefs ?? [];
  const guardrails = input.guardrails ?? [];
  const requiredApprovals = toolRefs.filter(
    (ref) => "require_approval" in ref && ref.require_approval,
  );
  const inboxGuardrails = guardrails.filter(
    (guardrail) => guardrail.human_inbox,
  );
  const blockedEgressInbox = Boolean(
    input.runtimePolicy?.network?.blocked_request_inbox,
  );

  return {
    runtimePolicy: runtimePolicyLines(input.runtimePolicy),
    toolAccess: [
      `Presets: ${compactList(
        input.toolPresets.map(formatToolPreset),
        "none",
      )}`,
      toolRefs.length === 0
        ? "No typed tool refs declared"
        : `Typed refs: ${compactList(toolRefs.map(formatToolRef), "none")}`,
    ],
    toolRefDetails: toolRefDetailLines(toolRefs),
    approvalRules: [
      APPROVAL_POLICY_LABELS[input.approvalPolicy],
      requiredApprovals.length === 0
        ? "No per-tool approval gates declared"
        : `${plural(requiredApprovals.length, "typed tool")} require approval`,
      blockedEgressInbox
        ? "Blocked egress requests route to approval inbox"
        : "Blocked egress inbox not declared",
      inboxGuardrails.length === 0
        ? "No guardrail inbox routing declared"
        : `${plural(inboxGuardrails.length, "guardrail")} can route to inbox`,
    ],
  };
}
