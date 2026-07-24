// ABOUTME: Global approval-inbox state: live in-renderer approval requests, host-persisted
// ABOUTME: pending continuations, per-thread blocked status, and the deduplicated background notification.

import { emit, listen } from "@tauri-apps/api/event";
import { createStore, reconcile } from "solid-js/store";
import { postNotification } from "@/services/notifications";
import {
  type ContinuationView,
  listPendingApprovals,
} from "@/services/tool-authorization";

/**
 * A live approval request whose executor promise is still waiting in this
 * renderer. Holds only display-safe fields — never the raw tool arguments.
 * `continuationId` links it to the host's suspended continuation when the host
 * was reachable at registration time.
 */
export interface LiveApprovalRequest {
  requestId: string;
  kind: "gateway" | "shell";
  publisherSlug?: string;
  toolName?: string;
  command?: string;
  threadId: string | null;
  description: string;
  isDestructive: boolean;
  continuationId?: string;
  receivedAt: number;
}

interface GatewayApprovalRequestPayload {
  approvalId: string;
  publisherSlug: string;
  toolName: string;
  threadId: string | null;
  description: string;
  isDestructive: boolean;
  continuationId?: string;
}

interface ShellApprovalRequestPayload {
  approvalId: string;
  command: string;
  timeoutSecs: number;
  threadId?: string | null;
  continuationId?: string;
}

interface StoreShape {
  live: LiveApprovalRequest[];
  pending: ContinuationView[];
}

/** Live requests outlive the executor's 5-minute window only by this margin. */
const LIVE_REQUEST_MAX_AGE_MS = 6 * 60 * 1000;

/** How often to re-read host state while anything is pending (observes TTL expiry). */
const PENDING_REFRESH_INTERVAL_MS = 60 * 1000;

const [state, setState] = createStore<StoreShape>({ live: [], pending: [] });

/**
 * Pending capability requests already notified this session. The host dedups
 * equivalent retries to one continuation, so keying on its id yields at most
 * one desktop notification per pending capability request.
 */
const notifiedApprovalIds = new Set<string>();

let initialized = false;

/** Every live pending approval across all conversations, oldest first. */
export function pendingApprovals(): ContinuationView[] {
  return state.pending;
}

/** The global badge count. */
export function pendingApprovalCount(): number {
  return state.pending.length;
}

/** Live (resolvable-in-this-renderer) requests, oldest first. */
export function liveApprovalRequests(): LiveApprovalRequest[] {
  return state.live;
}

/** Host-pending approvals bound to one conversation. */
export function pendingForConversation(
  conversationId: string,
): ContinuationView[] {
  return state.pending.filter((view) => view.taskId === conversationId);
}

/** The live request that can settle a given continuation, if this renderer holds it. */
export function liveRequestForContinuation(
  approvalId: string,
): LiveApprovalRequest | undefined {
  return state.live.find((request) => request.continuationId === approvalId);
}

/**
 * The persistent thread status label for a conversation, or null when nothing
 * is blocked. Linear blocks suspend the whole turn ("Waiting for approval");
 * branch-only blocks keep unrelated work running ("N actions blocked").
 */
export function threadApprovalStatus(conversationId: string): string | null {
  const pending = pendingForConversation(conversationId);
  if (pending.length === 0) return null;
  if (pending.some((view) => view.blockedScope === "linear")) {
    return "Waiting for approval";
  }
  return pending.length === 1
    ? "1 action blocked"
    : `${pending.length} actions blocked`;
}

/** Re-read host-pending approvals; prune lapsed live requests as a side effect. */
export async function refreshPendingApprovals(): Promise<void> {
  try {
    const pending = await listPendingApprovals();
    setState("pending", reconcile(pending));
    const cutoff = Date.now() - LIVE_REQUEST_MAX_AGE_MS;
    setState("live", (live) =>
      live.filter((request) => request.receivedAt >= cutoff),
    );
    maybeNotifyBackgrounded(pending);
  } catch (err) {
    console.error(
      "[Approvals Store] Failed to refresh pending approvals:",
      err,
    );
  }
}

/**
 * Settle a live approval request. `skipped` distinguishes "skip this action"
 * from a denial so the model receives a distinct, adaptable outcome.
 */
export async function respondToApproval(
  request: LiveApprovalRequest,
  outcome: {
    approved: boolean;
    skipped?: boolean;
    connectionId?: string | null;
  },
): Promise<void> {
  const channel =
    request.kind === "gateway"
      ? "gateway-tool-approval-response"
      : "shell-command-approval-response";
  try {
    await emit(channel, {
      id: request.requestId,
      approved: outcome.approved,
      skipped: outcome.skipped ?? false,
      connectionId: outcome.connectionId ?? null,
    });
  } catch (err) {
    console.error("[Approvals Store] Failed to emit approval response:", err);
    return;
  }
  setState("live", (live) =>
    live.filter((entry) => entry.requestId !== request.requestId),
  );
  // The executor settles the host continuation after the response round-trip;
  // refresh twice so the badge and thread status converge without a reload.
  setTimeout(() => void refreshPendingApprovals(), 300);
  setTimeout(() => void refreshPendingApprovals(), 1500);
}

function addLiveRequest(request: LiveApprovalRequest): void {
  setState("live", (live) => [
    ...live.filter((entry) => entry.requestId !== request.requestId),
    request,
  ]);
}

function removeLiveRequest(requestId: string): void {
  setState("live", (live) =>
    live.filter((entry) => entry.requestId !== requestId),
  );
}

function isBackgrounded(): boolean {
  return document.hidden || !document.hasFocus();
}

/**
 * One privacy-safe desktop notification per pending capability request, only
 * while the app is backgrounded. The body deliberately names nothing about the
 * operation — details stay in the app.
 */
function maybeNotifyBackgrounded(pending: ContinuationView[]): void {
  if (!isBackgrounded()) return;
  const unnotified = pending.filter(
    (view) => !notifiedApprovalIds.has(view.approvalId),
  );
  if (unnotified.length === 0) return;
  for (const view of unnotified) {
    notifiedApprovalIds.add(view.approvalId);
  }
  void showApprovalNotification();
}

async function showApprovalNotification(): Promise<void> {
  await postNotification(
    "Approval needed",
    "Seren is waiting for your approval to continue a task.",
  );
}

/**
 * Wire the store to the executor's approval events and the host store. Safe to
 * call more than once; only the first call registers listeners.
 */
export async function initializeApprovalsStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await listen<GatewayApprovalRequestPayload>(
    "gateway-tool-approval-request",
    (event) => {
      addLiveRequest({
        requestId: event.payload.approvalId,
        kind: "gateway",
        publisherSlug: event.payload.publisherSlug,
        toolName: event.payload.toolName,
        threadId: event.payload.threadId,
        description: event.payload.description,
        isDestructive: event.payload.isDestructive,
        continuationId: event.payload.continuationId,
        receivedAt: Date.now(),
      });
      void refreshPendingApprovals();
    },
  );

  await listen<ShellApprovalRequestPayload>(
    "shell-command-approval-request",
    (event) => {
      addLiveRequest({
        requestId: event.payload.approvalId,
        kind: "shell",
        command: event.payload.command,
        threadId: event.payload.threadId ?? null,
        description: "Run shell command",
        isDestructive: true,
        continuationId: event.payload.continuationId,
        receivedAt: Date.now(),
      });
      void refreshPendingApprovals();
    },
  );

  for (const channel of [
    "gateway-tool-approval-response",
    "shell-command-approval-response",
  ]) {
    await listen<{ id: string }>(channel, (event) => {
      removeLiveRequest(event.payload.id);
      setTimeout(() => void refreshPendingApprovals(), 300);
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshPendingApprovals();
  });

  setInterval(() => {
    if (state.pending.length > 0 || state.live.length > 0) {
      void refreshPendingApprovals();
    }
  }, PENDING_REFRESH_INTERVAL_MS);

  await refreshPendingApprovals();
}
