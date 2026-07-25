// ABOUTME: Inline timeline card for one authorization-blocked action: what was attempted,
// ABOUTME: why it needs a decision, what is blocked, and the five decision actions.

import {
  type Component,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { ApprovalActions } from "@/components/approvals/ApprovalActions";
import { cancelOrchestration } from "@/services/orchestrator";
import {
  type ContinuationView,
  grantCapabilityLease,
  type LeaseBudgets,
  type LeasePredicates,
} from "@/services/tool-authorization";
import {
  type LiveApprovalRequest,
  liveRequestForContinuation,
  respondToApproval,
} from "@/stores/approvals.store";

interface ApprovalRequestCardProps {
  view: ContinuationView;
}

function formatElapsed(sinceIso: string, nowMs: number): string {
  const started = Date.parse(sinceIso);
  if (Number.isNaN(started)) return "";
  const totalSecs = Math.max(0, Math.floor((nowMs - started) / 1000));
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  if (mins < 60) return `${mins}m ${totalSecs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Why the gate could not run this silently, in the host's terms. */
function uncoveredReason(view: ContinuationView): string {
  if (view.requestedCapability.operationClass === "high-risk") {
    return "High-risk operations require an explicit decision — no lease covers them unless you opt in.";
  }
  return "No active capability lease for this task covers this operation.";
}

/** The lease predicate that would cover this call, mirroring the gate's keys. */
function leasePredicatesFor(view: ContinuationView): LeasePredicates | null {
  const cap = view.requestedCapability;
  if (cap.route === "shell" || cap.route === "skill") {
    const first = cap.command?.trim().split(/\s+/)[0];
    const program = first?.split(/[/\\]/).pop()?.toLowerCase();
    return program ? { commandRules: [{ program }] } : null;
  }
  if (cap.route === "web") {
    return cap.host ? { networkHosts: [cap.host] } : null;
  }
  return {
    publisherOps: [
      {
        publisherSlug: cap.publisherSlug,
        allowHighRisk: cap.operationClass === "high-risk",
        target: cap.target,
      },
    ],
  };
}

function leaseSummaryFor(view: ContinuationView): string {
  const cap = view.requestedCapability;
  if (cap.route === "shell" || cap.route === "skill") {
    const first = cap.command?.trim().split(/\s+/)[0];
    const program = first?.split(/[/\\]/).pop()?.toLowerCase();
    return program ? `"${program}" commands` : "this command";
  }
  if (cap.route === "web") {
    return cap.host ? `web access to ${cap.host}` : "this web fetch";
  }
  return `${cap.publisherSlug} operations`;
}

/**
 * One pending authorization-blocked action, rendered at the timeline's
 * suspension point so a block is never a hung agent. All five decisions are
 * available inline while the request is live in this renderer; a request from
 * an earlier app session is shown read-only with its auto-expiry time. Once
 * decided, the store drops the request and the settled outcome is carried by
 * the tool-result message, the thread status, and the audit history.
 */
export const ApprovalRequestCard: Component<ApprovalRequestCardProps> = (
  props,
) => {
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [isProcessing, setIsProcessing] = createSignal(false);

  onMount(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  const live = createMemo<LiveApprovalRequest | undefined>(() =>
    liveRequestForContinuation(props.view.approvalId),
  );

  const cap = () => props.view.requestedCapability;

  const respond = async (outcome: { approved: boolean; skipped?: boolean }) => {
    const request = live();
    if (!request || isProcessing()) return;
    setIsProcessing(true);
    try {
      await respondToApproval(request, outcome);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApproveForTask = async (
    durationSecs: number,
    budgets: LeaseBudgets,
  ) => {
    const request = live();
    if (!request || isProcessing()) return;
    const predicates = leasePredicatesFor(props.view);
    if (predicates) {
      try {
        await grantCapabilityLease(
          props.view.taskId,
          `Task lease: ${leaseSummaryFor(props.view)}`,
          durationSecs,
          predicates,
          budgets,
        );
      } catch (err) {
        console.error(
          "[ApprovalRequestCard] Failed to grant task lease; approving once:",
          err,
        );
      }
    }
    await respond({ approved: true });
  };

  const handleStopTask = async () => {
    await respond({ approved: false });
    try {
      await cancelOrchestration(props.view.taskId);
    } catch (err) {
      console.error("[ApprovalRequestCard] Failed to stop task:", err);
    }
  };

  return (
    <div class="mx-5 my-3 border border-warning/40 rounded-xl overflow-hidden bg-surface-1/60">
      <div class="px-4 py-3 flex items-center gap-2 border-b border-border bg-warning/10">
        <span class="text-[0.95rem] font-semibold text-foreground">
          Approval needed
        </span>
        <Show when={cap().isDestructive}>
          <span class="text-[0.75rem] font-medium text-destructive border border-destructive/40 rounded px-1.5 py-0.5">
            destructive
          </span>
        </Show>
        <span class="text-[0.75rem] font-medium text-muted-foreground border border-border rounded px-1.5 py-0.5">
          {cap().operationClass}
        </span>
        <span class="ml-auto text-[0.8rem] text-muted-foreground">
          pending for {formatElapsed(props.view.createdAt, nowMs())}
        </span>
      </div>

      <div class="px-4 py-3 flex flex-col gap-2 text-[0.9rem]">
        <div class="text-foreground">
          {cap().description || `${cap().publisherSlug}/${cap().toolName}`}
        </div>
        <div class="text-muted-foreground font-[var(--font-mono)] text-[0.8rem]">
          {cap().route} · {cap().publisherSlug}/{cap().toolName}
          <Show when={cap().command}>{(command) => <> · {command()}</>}</Show>
          <Show when={cap().host}>{(host) => <> · {host()}</>}</Show>
          <Show when={cap().target}>
            {(target) => <> · account/resource: {target()}</>}
          </Show>
        </div>
        <div class="text-[0.85rem] text-muted-foreground">
          {uncoveredReason(props.view)}
        </div>
        <div class="text-[0.85rem] text-muted-foreground">
          {props.view.blockedScope === "linear"
            ? "The task is paused until you decide."
            : "Unrelated work in this task is continuing while this action waits."}
        </div>
        <Show when={!live()}>
          <div class="text-[0.85rem] text-warning">
            This request is no longer resolvable from here (it belongs to an
            earlier app session). It expires automatically at{" "}
            {new Date(props.view.expiresAt).toLocaleTimeString()}.
          </div>
        </Show>
      </div>

      <Show when={live()}>
        <ApprovalActions
          isProcessing={isProcessing()}
          approveOnceLabel="Approve once"
          leaseSummary={leaseSummaryFor(props.view)}
          onApproveOnce={() => void respond({ approved: true })}
          onApproveForTask={(durationSecs, budgets) =>
            void handleApproveForTask(durationSecs, budgets)
          }
          onDeny={() => void respond({ approved: false })}
          onSkip={() => void respond({ approved: false, skipped: true })}
          onStopTask={() => void handleStopTask()}
        />
      </Show>
    </div>
  );
};

export default ApprovalRequestCard;
