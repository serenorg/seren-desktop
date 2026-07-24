// ABOUTME: Inspect-and-revoke panel for a conversation's capability leases, with the
// ABOUTME: authorization audit history (lease lifecycle, approval outcomes, decisions).

import {
  type Component,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import {
  type AuthorizationAuditEntry,
  type CapabilityLease,
  listAuthorizationAudit,
  listCapabilityLeases,
  revokeCapabilityLease,
} from "@/services/tool-authorization";

interface CapabilityLeasePanelProps {
  conversationId: string;
}

const AUDIT_EVENT_LABELS: Record<string, string> = {
  lease_granted: "Lease granted",
  lease_auto_granted: "Lease auto-granted from policy",
  lease_used: "Ran under lease",
  lease_denied: "Denied by lease exclusion",
  lease_expired: "Lease expired",
  lease_revoked: "Lease revoked",
  approval_requested: "Approval requested",
  approval_approved: "Approved",
  approval_denied: "Denied",
  approval_skipped: "Skipped",
  approval_expired: "Approval expired",
  decision_granted: "Session grant stored",
  decision_denied: "Session denial stored",
};

function leaseIsActive(lease: CapabilityLease): boolean {
  return !lease.revoked && Date.parse(lease.expiresAt) > Date.now();
}

function leaseStatus(lease: CapabilityLease): string {
  if (lease.revoked) return "revoked";
  if (Date.parse(lease.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function describePredicates(lease: CapabilityLease): string {
  const parts: string[] = [];
  const commands = lease.predicates.commandRules ?? [];
  if (commands.length > 0) {
    parts.push(`commands: ${commands.map((rule) => rule.program).join(", ")}`);
  }
  const hosts = lease.predicates.networkHosts ?? [];
  if (hosts.length > 0) {
    parts.push(`hosts: ${hosts.join(", ")}`);
  }
  const ops = lease.predicates.publisherOps ?? [];
  if (ops.length > 0) {
    parts.push(
      `publishers: ${ops
        .map(
          (rule) =>
            rule.publisherSlug +
            (rule.target ? ` (${rule.target})` : "") +
            (rule.allowHighRisk ? " incl. high-risk" : ""),
        )
        .join(", ")}`,
    );
  }
  const exclusions = lease.predicates.exclusions ?? [];
  if (exclusions.length > 0) {
    parts.push(`${exclusions.length} exclusion(s)`);
  }
  return parts.join(" · ") || "no predicates";
}

function describeBudgets(lease: CapabilityLease): string {
  const used = lease.budgets.callsUsed ?? 0;
  const max = lease.budgets.maxCalls;
  const calls =
    max != null ? `${used}/${max} calls used` : `${used} calls used`;
  if (lease.budgets.maxSpendMicros != null) {
    const spent = (lease.budgets.spendUsedMicros ?? 0) / 1_000_000;
    const cap = lease.budgets.maxSpendMicros / 1_000_000;
    return `${calls} · ${spent}/${cap} ${lease.budgets.asset ?? ""} spent`;
  }
  return calls;
}

/**
 * The user-facing half of lease lifecycle (#3193 §8): every lease bound to this
 * conversation with its scope, budget usage, and expiry — revocable in one
 * click, effective on the gate's next evaluation — plus the audit history.
 */
export const CapabilityLeasePanel: Component<CapabilityLeasePanelProps> = (
  props,
) => {
  const [revision, setRevision] = createSignal(0);
  const [revokingId, setRevokingId] = createSignal<string | null>(null);

  const [leases] = createResource(
    () => [props.conversationId, revision()] as const,
    async ([conversationId]) => listCapabilityLeases(conversationId),
  );

  const [audit] = createResource(
    () => [props.conversationId, revision()] as const,
    async ([conversationId]) => listAuthorizationAudit(conversationId, 50),
  );

  const handleRevoke = async (lease: CapabilityLease) => {
    if (revokingId()) return;
    setRevokingId(lease.id);
    try {
      await revokeCapabilityLease(lease.id);
      setRevision((n) => n + 1);
    } catch (err) {
      console.error("[CapabilityLeasePanel] Failed to revoke lease:", err);
    } finally {
      setRevokingId(null);
    }
  };

  const auditLine = (entry: AuthorizationAuditEntry): string => {
    const label = AUDIT_EVENT_LABELS[entry.event] ?? entry.event;
    const operation =
      entry.publisherSlug && entry.toolName
        ? ` — ${entry.publisherSlug}/${entry.toolName}`
        : "";
    const detail = entry.detail ? ` (${entry.detail})` : "";
    return `${label}${operation}${detail}`;
  };

  return (
    <div class="border border-border rounded-lg bg-surface-1/60 overflow-hidden">
      <div class="px-4 py-2.5 border-b border-border text-[0.85rem] font-semibold text-foreground">
        Capability leases
      </div>
      <div class="px-4 py-3 flex flex-col gap-2">
        <Show
          when={(leases() ?? []).length > 0}
          fallback={
            <span class="text-[0.85rem] text-muted-foreground">
              No capability leases for this task. Approve an action "for this
              task" to create one.
            </span>
          }
        >
          <For each={leases()}>
            {(lease) => (
              <div class="border border-border rounded-lg px-3 py-2.5 flex flex-col gap-1.5">
                <div class="flex items-center gap-2">
                  <span class="text-[0.88rem] text-foreground font-medium">
                    {lease.label}
                  </span>
                  <span
                    class={`text-[0.72rem] font-medium rounded px-1.5 py-0.5 border ${
                      leaseStatus(lease) === "active"
                        ? "text-success border-success/40"
                        : "text-muted-foreground border-border"
                    }`}
                  >
                    {leaseStatus(lease)}
                  </span>
                  <Show when={leaseIsActive(lease)}>
                    <button
                      type="button"
                      class="ml-auto px-2.5 py-1 text-[0.78rem] font-medium rounded-md cursor-pointer bg-transparent text-destructive border border-destructive/40 hover:bg-destructive/10 disabled:opacity-50"
                      onClick={() => void handleRevoke(lease)}
                      disabled={revokingId() !== null}
                    >
                      {revokingId() === lease.id ? "Revoking…" : "Revoke now"}
                    </button>
                  </Show>
                </div>
                <span class="text-[0.78rem] text-muted-foreground">
                  {describePredicates(lease)}
                </span>
                <span class="text-[0.78rem] text-muted-foreground">
                  {describeBudgets(lease)} · expires{" "}
                  {new Date(lease.expiresAt).toLocaleString()}
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="px-4 py-2.5 border-t border-b border-border text-[0.85rem] font-semibold text-foreground">
        Authorization history
      </div>
      <div class="px-4 py-3 max-h-64 overflow-y-auto">
        <Show
          when={(audit() ?? []).length > 0}
          fallback={
            <span class="text-[0.85rem] text-muted-foreground">
              No authorization events recorded for this task yet.
            </span>
          }
        >
          <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
            <For each={audit()}>
              {(entry) => (
                <li class="text-[0.78rem] text-muted-foreground flex gap-2">
                  <span class="shrink-0 font-[var(--font-mono)]">
                    {new Date(entry.createdAt).toLocaleTimeString()}
                  </span>
                  <span class="min-w-0">{auditLine(entry)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
};

export default CapabilityLeasePanel;
