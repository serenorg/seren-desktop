// ABOUTME: Tool executor that routes tool calls to file operations, MCP servers, or gateway.
// ABOUTME: Handles tool call parsing, execution, and result formatting.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mcpClient } from "@/lib/mcp/client";
import { isOAuthTokenError } from "@/lib/oauth-tool-errors";
import type { ToolCall, ToolResult } from "@/lib/providers/types";
import { reportError } from "@/lib/support/hook";
import {
  type PaymentRequirements,
  parsePaymentRequirements,
  resolvePaymentCharge,
} from "@/lib/x402";
import {
  callGatewayTool,
  callSerenTool,
  type PaymentProxyInfo,
} from "@/services/mcp-gateway";
import { computeAgentOAuthRouting } from "@/services/publisher-oauth";
import { startShellProgressListener } from "@/services/shell-progress";
import { x402Service } from "@/services/x402";
import { conversationStore } from "@/stores/conversation.store";
import { parseGatewayToolName, parseMcpToolName } from "./definitions";

const GATEWAY_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SHELL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RESULT_SIZE = 50_000; // 50KB cap
const MAX_ARRAY_ITEMS = 25;

interface GatewayApprovalResult {
  approved: boolean;
  connectionId?: string | null;
  /** True when the approval UI lapsed without a decision, so the block is an
   * explicit expiry rather than a user denial. */
  timedOut?: boolean;
  /** True when the user chose "skip this action": the task continues without
   * it, distinct from a denial and never persisted as one. */
  skipped?: boolean;
}

/** Links an approval prompt to its host continuation and thread so the inline
 * card and global inbox can identify (and settle) the exact suspended action. */
interface ApprovalLink {
  threadId: string | null;
  continuationId?: string;
}

interface GatewayConnectionArgsResult {
  args: Record<string, unknown>;
  error?: string;
}

interface GatewayApprovalPrompt {
  description?: string;
  isDestructive?: boolean;
  /** Host classification wire token (trusted-read/high-risk/unclassified). */
  operationClass?: string;
}

/**
 * Executor route the Rust gate classifies. Keep in sync with `ToolRoute` in
 * `src-tauri/src/tool_authorization.rs`.
 */
type ToolRoute = "gateway" | "seren" | "mcp" | "shell" | "skill" | "web";

/**
 * The host gate's decision. `decision` is authoritative; the renderer only
 * displays `description`/`isDestructive` and dispatches — it never classifies.
 */
interface AuthorizationDecision {
  decision: "allow" | "deny" | "prompt";
  promptKind: "one-shot" | "session" | null;
  operationClass: "trusted-read" | "high-risk" | "unclassified";
  description: string;
  isDestructive: boolean;
  /** Host-minted dispatch handle, present only on "allow" (#3193-F). The
   * transports refuse to execute without it; this code only ferries it. */
  handle?: string | null;
  /** Opaque host-computed operation binding, present on "prompt". Echoed into
   * the suspended continuation so the post-approval handle is bound to the
   * exact operation the gate blocked. */
  binding?: string | null;
}

// A gate failure must never become a silent allow.
const DENY_DECISION: AuthorizationDecision = {
  decision: "deny",
  promptKind: null,
  operationClass: "unclassified",
  description: "",
  isDestructive: false,
};

/**
 * The small argument slice the host gate needs to evaluate a capability-lease
 * predicate for this call. Keep in sync with `OperationContext` in
 * `src-tauri/src/tool_authorization.rs`. Every field is optional: a call that
 * omits one simply cannot match a predicate that requires it.
 */
interface OperationContext {
  command?: string;
  host?: string;
  target?: string;
  costMicros?: number;
}

/**
 * Extract the lease-predicate context from a publisher-style call's arguments.
 * The resource/account/connection constraint keys off `connection_id` — the
 * OAuth account identity this codebase already resolves — and a web fetch keys
 * off its URL host.
 */
function contextForPublisherRoute(
  route: ToolRoute,
  args: Record<string, unknown>,
): OperationContext {
  const context: OperationContext = {};
  if (route === "web") {
    const url = typeof args.url === "string" ? args.url : undefined;
    if (url) {
      try {
        context.host = new URL(url).host;
      } catch {
        // A malformed URL yields no host; the call cannot match a host predicate.
      }
    }
    return context;
  }
  if (typeof args.connection_id === "string" && args.connection_id.length > 0) {
    context.target = args.connection_id;
  }
  return context;
}

// A continuation outlives the approval UI's own timeout, so the renderer's
// timeout fires first and settles the block as an *explicit* expiry rather than
// the host auto-expiring it mid-prompt.
const APPROVAL_CONTINUATION_TTL_SECS =
  Math.floor(GATEWAY_APPROVAL_TIMEOUT_MS / 1000) + 60;

/**
 * What the gate blocked, in the host's terms. Mirrors `RequestedCapability` in
 * `src-tauri/src/approval_continuation.rs`.
 */
interface RequestedCapability {
  route: ToolRoute;
  publisherSlug: string;
  toolName: string;
  operationClass: string;
  description: string;
  isDestructive: boolean;
  command?: string;
  host?: string;
  target?: string;
  /** Opaque host-computed operation binding from the gate's prompt decision. */
  binding?: string;
}

/**
 * The host's record of a suspended continuation. `resumeToken` is held here to
 * settle the block and is NEVER forwarded to the model; `modelResult` is the
 * redacted payload safe to surface. Mirrors `RegisteredContinuation` in
 * `src-tauri/src/approval_continuation.rs`.
 */
interface RegisteredContinuation {
  approvalId: string;
  resumeToken: string;
  blockedScope: "linear" | "branch";
  taskState: string;
  deduplicated: boolean;
  modelResult: Record<string, unknown>;
}

/**
 * The host's answer to settling a continuation. `dispatchHandle` is present
 * only on the single pending→approved settle (#3193-F) — it is the proof the
 * transports require before executing the approved operation.
 */
interface ResolveOutcome {
  changed: boolean;
  state: "pending" | "approved" | "denied" | "skipped" | "expired";
  taskState: string;
  dispatchHandle?: string | null;
}

/**
 * Outcome of authorizing one tool call. On approval the host-minted dispatch
 * `handle` accompanies it — every transport refuses to execute without one. On
 * a block, the structured tool result is ready to return to the model — never a
 * generic "not approved" string, so a denial, expiry, and skip are
 * distinguishable and the model can adapt.
 */
type ToolAuthorization =
  | { approved: true; handle: string; connectionId?: string | null }
  | { approved: false; toolResult: ToolResult };

type BlockedKind = "denied" | "expired" | "skipped";

/**
 * Register a host-owned suspended continuation for a blocked action, so the
 * paused action becomes a visible, resumable record (never a hung tool call) and
 * equivalent retries dedup to one pending request. Returns null if the host is
 * unavailable — the action then fails closed, since only a settled continuation
 * can mint the dispatch handle the transports require (#3193-F).
 */
async function registerApprovalContinuation(
  route: ToolRoute,
  publisherSlug: string,
  toolName: string,
  decision: AuthorizationDecision,
  context: OperationContext,
  conversationId: string,
): Promise<RegisteredContinuation | null> {
  const requested: RequestedCapability = {
    route,
    publisherSlug,
    toolName,
    operationClass: decision.operationClass,
    description: decision.description,
    isDestructive: decision.isDestructive,
    command: context.command,
    host: context.host,
    target: context.target,
    binding: decision.binding ?? undefined,
  };
  try {
    return await invoke<RegisteredContinuation>(
      "register_approval_continuation",
      {
        conversationId,
        requested,
        scope: "linear",
        ttlSecs: APPROVAL_CONTINUATION_TTL_SECS,
      },
    );
  } catch (err) {
    console.error(
      "[Tool Executor] Failed to register approval continuation:",
      err,
    );
    return null;
  }
}

/**
 * Settle a suspended continuation exactly once. Approve/deny/skip are user
 * decisions; expire is the system outcome of a lapsed approval UI. Idempotent
 * host-side. Returns the host outcome — an approve settle carries the
 * dispatch handle the transports require — or null when the host call failed
 * (the dispatch then fails closed for lack of a handle).
 */
async function settleApprovalContinuation(
  registered: RegisteredContinuation,
  kind: "approve" | "deny" | "skip" | "expire",
): Promise<ResolveOutcome | null> {
  try {
    if (kind === "expire") {
      return await invoke<ResolveOutcome>("expire_approval_continuation", {
        approvalId: registered.approvalId,
        resumeToken: registered.resumeToken,
      });
    }
    return await invoke<ResolveOutcome>("resolve_approval_continuation", {
      approvalId: registered.approvalId,
      resumeToken: registered.resumeToken,
      decision: kind,
    });
  } catch (err) {
    console.error(
      "[Tool Executor] Failed to settle approval continuation:",
      err,
    );
    return null;
  }
}

/**
 * The host's verdict on reserving a priced call's realized cost against its
 * covering lease (#3193-G). Mirrors `SpendReservation` in
 * `src-tauri/src/tool_authorization.rs`.
 */
interface SpendReservation {
  outcome: "charged" | "escalate" | "uncovered";
  reservationId?: string;
}

/**
 * Reserve a priced call's realized cost against the lease that covers it, at the
 * x402 payment gate and before any payment is signed. Fails closed: if the host
 * cannot verify the budget, the call is treated as an escalation (an explicit
 * prompt) rather than a silent payment.
 */
async function reserveLeaseSpend(
  publisherSlug: string,
  toolName: string,
  conversationId: string,
  context: OperationContext,
  costMicros: number,
  asset: string,
): Promise<SpendReservation> {
  try {
    const reservation = await invoke<SpendReservation>("reserve_lease_spend", {
      route: "gateway",
      publisherSlug,
      toolName,
      conversationId,
      context,
      asset,
      costMicros,
    });
    // A malformed response cannot be trusted to have metered the budget:
    // fail closed to an explicit prompt rather than a silent payment.
    if (
      reservation?.outcome === "charged" ||
      reservation?.outcome === "escalate" ||
      reservation?.outcome === "uncovered"
    ) {
      return reservation;
    }
    return { outcome: "escalate" };
  } catch (err) {
    console.error("[Tool Executor] Failed to reserve lease spend:", err);
    return { outcome: "escalate" };
  }
}

/**
 * Settle a spend reservation once its payment resolves. `settledMicros` null
 * releases the whole reservation (the payment never completed); a number
 * reconciles the lease's spend to the amount actually paid. Best-effort: a failed
 * settle leaves the reserved charge standing (a conservative over-charge), never a
 * silent release.
 */
async function settleLeaseSpend(
  reservationId: string,
  settledMicros: number | null,
): Promise<void> {
  try {
    await invoke("settle_lease_spend", {
      reservationId,
      settledMicros: settledMicros ?? undefined,
    });
  } catch (err) {
    console.error("[Tool Executor] Failed to settle lease spend:", err);
  }
}

/**
 * A structured tool result for a blocked action. Distinguishes denial, expiry,
 * and skip and carries adaptation guidance, so the model gets a clear, distinct
 * signal instead of a generic, ambiguous "not approved" error.
 */
function blockedToolResult(
  toolCallId: string,
  kind: BlockedKind,
  capability: string,
  approvalId?: string,
): ToolResult {
  const guidance: Record<BlockedKind, string> = {
    denied:
      "The user denied this action. Do not retry it; continue the task without it or ask how to proceed.",
    expired:
      "The approval request expired before the user decided. Do not retry automatically; report that this action is still pending authorization.",
    skipped:
      "The user skipped this action. Continue with the rest of the task and do not retry it.",
  };
  const payload: Record<string, unknown> = {
    status: `action_${kind}`,
    capability,
    message: guidance[kind],
  };
  if (approvalId) {
    payload.approvalId = approvalId;
  }
  return {
    tool_call_id: toolCallId,
    content: JSON.stringify(payload),
    is_error: true,
  };
}

/**
 * Ask the host gate to classify a model-originated call. Passing through the
 * gate never itself prompts the user; it returns allow/deny/prompt.
 */
async function consultAuthorizationGate(
  route: ToolRoute,
  publisherSlug: string,
  toolName: string,
  conversationId: string,
  context: OperationContext,
  callArgs: Record<string, unknown>,
): Promise<AuthorizationDecision> {
  try {
    return await invoke<AuthorizationDecision>("authorize_tool_operation", {
      route,
      publisherSlug,
      toolName,
      conversationId,
      context,
      // The host derives the exact-operation binding from the full argument
      // payload; without it no dispatch handle can be minted (#3193-F).
      callArgs,
    });
  } catch (err) {
    console.error("[Tool Executor] Authorization gate unavailable:", err);
    return DENY_DECISION;
  }
}

/**
 * Persist a prompt outcome host-side. The host re-derives classification, so a
 * high-risk (one-shot) or trusted-read (silent) operation is never made durable
 * here — only unclassified session decisions are stored.
 */
async function recordAuthorizationDecision(
  route: ToolRoute,
  publisherSlug: string,
  toolName: string,
  conversationId: string,
  approved: boolean,
): Promise<void> {
  try {
    await invoke("record_tool_operation_decision", {
      route,
      publisherSlug,
      toolName,
      conversationId,
      approved,
    });
  } catch (err) {
    // A failed persist is safe: the next call re-prompts rather than mis-trusting.
    console.error(
      "[Tool Executor] Failed to record authorization decision:",
      err,
    );
  }
}

/**
 * Emit an event to notify the UI that an OAuth connection has expired.
 * The OAuthLogins component listens for this to update the connection status.
 */
async function notifyOAuthExpired(
  publisherSlug: string,
  errorMessage: string,
): Promise<void> {
  try {
    await emit("oauth-connection-expired", {
      publisherSlug,
      errorMessage,
      timestamp: Date.now(),
    });
    console.log(
      `[Tool Executor] Emitted oauth-connection-expired for ${publisherSlug}`,
    );
  } catch (err) {
    console.error(
      "[Tool Executor] Failed to emit oauth-connection-expired:",
      err,
    );
  }
}

/**
 * Truncate large tool results to prevent overwhelming the AI context and database.
 * For JSON arrays (e.g. email lists), extracts key summary fields per item.
 */
function truncateToolResult(content: string): string {
  if (content.length <= MAX_RESULT_SIZE) return content;

  // Try to detect JSON array results (emails, records, etc.)
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed) && parsed.length > MAX_ARRAY_ITEMS) {
      const total = parsed.length;
      const summary = parsed.slice(0, MAX_ARRAY_ITEMS).map((item: unknown) => {
        if (typeof item === "object" && item !== null) {
          const record = item as Record<string, unknown>;
          const keys = Object.keys(record);
          const summaryKeys = [
            "id",
            "subject",
            "title",
            "name",
            "from",
            "sender",
            "date",
            "timestamp",
            "created_at",
            "snippet",
            "status",
            "type",
          ];
          const kept: Record<string, unknown> = {};
          for (const k of keys) {
            const val = record[k];
            if (
              summaryKeys.includes(k.toLowerCase()) ||
              typeof val !== "string" ||
              val.length < 200
            ) {
              kept[k] =
                typeof val === "string" && val.length > 200
                  ? `${val.slice(0, 200)}...`
                  : val;
            }
          }
          return Object.keys(kept).length > 0 ? kept : item;
        }
        return item;
      });
      return `${JSON.stringify(summary, null, 2)}\n\n[Showing ${MAX_ARRAY_ITEMS} of ${total} items. Full results truncated.]`;
    }
  } catch {
    // Not JSON, fall through to plain text truncation
  }

  return `${content.slice(0, MAX_RESULT_SIZE)}\n\n[Truncated: result was ${content.length.toLocaleString()} characters]`;
}

/**
 * Request user approval for a Gateway tool operation.
 * Returns a promise that resolves to true if approved, false if denied or timeout.
 */
async function requestGatewayApproval(
  publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
  conversationId: string | null,
  prompt?: GatewayApprovalPrompt,
  link?: ApprovalLink,
): Promise<GatewayApprovalResult> {
  const approvalId = `gateway-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  console.log(
    `[Tool Executor] Requesting approval for ${publisherSlug}/${toolName} (ID: ${approvalId})`,
  );

  // Emit approval request event for UI to display. Display metadata is
  // host-owned (from the gate decision); the renderer does not classify.
  try {
    await emit("gateway-tool-approval-request", {
      approvalId,
      publisherSlug,
      toolName,
      args,
      threadId:
        link?.threadId ??
        conversationId ??
        conversationStore.activeConversationId,
      description: prompt?.description ?? "Execute operation",
      isDestructive: prompt?.isDestructive ?? false,
      operationClass: prompt?.operationClass,
      continuationId: link?.continuationId,
    });
  } catch (err) {
    console.error("[Tool Executor] Failed to emit approval request:", err);
    return { approved: false };
  }

  // Wait for approval response
  return new Promise((resolve) => {
    let unlisten: UnlistenFn | undefined;
    const timeout = setTimeout(() => {
      console.log(`[Tool Executor] Approval timeout for ${approvalId}`);
      unlisten?.();
      // Tell the UI the request expired so the modal dismisses itself instead
      // of lingering over an action the executor has already abandoned.
      void emit("gateway-tool-approval-response", {
        id: approvalId,
        approved: false,
        expired: true,
      });
      resolve({ approved: false, timedOut: true });
    }, GATEWAY_APPROVAL_TIMEOUT_MS);

    listen<{
      id: string;
      approved: boolean;
      connectionId?: string | null;
      skipped?: boolean;
    }>("gateway-tool-approval-response", (event) => {
      if (event.payload.id !== approvalId) return;
      console.log(
        `[Tool Executor] Received approval response: ${event.payload.approved}`,
      );
      clearTimeout(timeout);
      unlisten?.();
      resolve({
        approved: event.payload.approved,
        connectionId: event.payload.connectionId ?? null,
        skipped: event.payload.skipped ?? false,
      });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("[Tool Executor] Failed to listen for approval:", err);
        clearTimeout(timeout);
        resolve({ approved: false });
      });
  });
}

function sessionConversationId(conversationId: string | null): string {
  return (
    conversationId ??
    conversationStore.activeConversationId ??
    "session-without-conversation"
  );
}

/**
 * Consult the host authorization gate for a publisher-style route (gateway,
 * built-in Seren, local MCP, or web fetch) and honor its decision. The host owns
 * classification and the persisted decision state; the renderer only runs the
 * approval UI when told to prompt and reports the outcome back for persistence.
 */
async function authorizeToolOperation(
  route: ToolRoute,
  publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
  conversationId: string | null,
  toolCallId: string,
): Promise<ToolAuthorization> {
  const sessionId = sessionConversationId(conversationId);
  const context = contextForPublisherRoute(route, args);
  const decision = await consultAuthorizationGate(
    route,
    publisherSlug,
    toolName,
    sessionId,
    context,
    args,
  );
  const capability = `${publisherSlug}/${toolName}`;

  if (decision.decision === "allow") {
    // An allow without a redeemable handle cannot dispatch — fail closed
    // rather than let the transport produce a confusing refusal.
    if (!decision.handle) {
      reportError(
        "ToolDispatchHandleMissing",
        `Host allowed ${capability} but minted no dispatch handle`,
      );
      return {
        approved: false,
        toolResult: blockedToolResult(toolCallId, "denied", capability),
      };
    }
    return { approved: true, handle: decision.handle };
  }
  if (decision.decision === "deny") {
    console.log(`[Tool Executor] Host denied ${publisherSlug}/${toolName}`);
    return {
      approved: false,
      toolResult: blockedToolResult(toolCallId, "denied", capability),
    };
  }

  // A prompt suspends the action: record it host-side so the block is visible and
  // resumable (never a hung call), then run the approval UI and settle it exactly
  // once with the outcome. The continuation is also where the post-approval
  // dispatch handle is minted (#3193-F), so registration failing means the
  // action cannot proceed even if the user approves — fail closed up front.
  const registered = await registerApprovalContinuation(
    route,
    publisherSlug,
    toolName,
    decision,
    context,
    sessionId,
  );
  if (!registered) {
    return {
      approved: false,
      toolResult: blockedToolResult(toolCallId, "denied", capability),
    };
  }

  const approval = await requestGatewayApproval(
    publisherSlug,
    toolName,
    args,
    conversationId,
    {
      description: decision.description,
      isDestructive: decision.isDestructive,
      operationClass: decision.operationClass,
    },
    { threadId: sessionId, continuationId: registered.approvalId },
  );

  // Only an explicit approve/deny is durable. A timeout is an expiry and a skip
  // is a one-time "continue without this action" — persisting either would
  // auto-deny the operation on the next attempt, so the decision store is left
  // untouched and a later call re-prompts.
  if (!approval.timedOut && !approval.skipped) {
    await recordAuthorizationDecision(
      route,
      publisherSlug,
      toolName,
      sessionId,
      approval.approved,
    );
  }

  if (approval.approved) {
    const settled = await settleApprovalContinuation(registered, "approve");
    // Only the pending→approved settle mints a handle. A deduped duplicate or
    // a host-side expiry yields none — the dispatch fails closed and the model
    // may retry through a fresh gate consultation.
    if (!settled?.dispatchHandle) {
      const kind: BlockedKind =
        settled?.state === "expired" ? "expired" : "denied";
      return {
        approved: false,
        toolResult: blockedToolResult(
          toolCallId,
          kind,
          capability,
          registered.approvalId,
        ),
      };
    }
    return {
      approved: true,
      handle: settled.dispatchHandle,
      connectionId: approval.connectionId,
    };
  }

  const kind: BlockedKind = approval.timedOut
    ? "expired"
    : approval.skipped
      ? "skipped"
      : "denied";
  await settleApprovalContinuation(
    registered,
    approval.timedOut ? "expire" : approval.skipped ? "skip" : "deny",
  );
  return {
    approved: false,
    toolResult: blockedToolResult(
      toolCallId,
      kind,
      capability,
      registered.approvalId,
    ),
  };
}

/**
 * Consult the host gate for a subprocess route (shell command or skill script)
 * and run the shell approval UI when the gate asks to prompt. Subprocess
 * execution always classifies high-risk host-side, so the gate never persists a
 * grant; `runApprovalUi` runs on every call, preserving the always-prompt
 * posture while making the host the single decision point. Fails closed.
 */
async function authorizeSubprocess(
  route: "shell" | "skill",
  toolName: string,
  command: string,
  args: Record<string, unknown>,
  conversationId: string | null,
  toolCallId: string,
  runApprovalUi: (link: ApprovalLink) => Promise<GatewayApprovalResult>,
): Promise<ToolAuthorization> {
  const sessionId = sessionConversationId(conversationId);
  const context: OperationContext = { command };
  const decision = await consultAuthorizationGate(
    route,
    "seren",
    toolName,
    sessionId,
    context,
    args,
  );
  // The lease/gate key a subprocess on its leading program token; use that as the
  // capability label so a block names what the user actually saw.
  const capability = command.trim().split(/\s+/)[0] || toolName;

  if (decision.decision === "deny") {
    return {
      approved: false,
      toolResult: blockedToolResult(toolCallId, "denied", capability),
    };
  }
  if (decision.decision === "allow") {
    if (!decision.handle) {
      reportError(
        "ToolDispatchHandleMissing",
        `Host allowed ${capability} but minted no dispatch handle`,
      );
      return {
        approved: false,
        toolResult: blockedToolResult(toolCallId, "denied", capability),
      };
    }
    return { approved: true, handle: decision.handle };
  }

  // The continuation mints the post-approval dispatch handle (#3193-F);
  // without it an approval cannot execute, so registration is required.
  const registered = await registerApprovalContinuation(
    route,
    "seren",
    toolName,
    decision,
    context,
    sessionId,
  );
  if (!registered) {
    return {
      approved: false,
      toolResult: blockedToolResult(toolCallId, "denied", capability),
    };
  }
  const outcome = await runApprovalUi({
    threadId: sessionId,
    continuationId: registered.approvalId,
  });

  if (outcome.approved) {
    const settled = await settleApprovalContinuation(registered, "approve");
    if (!settled?.dispatchHandle) {
      const kind: BlockedKind =
        settled?.state === "expired" ? "expired" : "denied";
      return {
        approved: false,
        toolResult: blockedToolResult(
          toolCallId,
          kind,
          capability,
          registered.approvalId,
        ),
      };
    }
    return { approved: true, handle: settled.dispatchHandle };
  }

  const kind: BlockedKind = outcome.timedOut
    ? "expired"
    : outcome.skipped
      ? "skipped"
      : "denied";
  await settleApprovalContinuation(
    registered,
    outcome.timedOut ? "expire" : outcome.skipped ? "skip" : "deny",
  );
  return {
    approved: false,
    toolResult: blockedToolResult(
      toolCallId,
      kind,
      capability,
      registered.approvalId,
    ),
  };
}

async function resolveGatewayOAuthConnectionArgs(
  publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
  conversationId: string | null,
): Promise<GatewayConnectionArgsResult> {
  if (typeof args.connection_id === "string" && args.connection_id.length > 0) {
    return { args };
  }

  const threadId = conversationId ?? conversationStore.activeConversationId;
  const routing = await computeAgentOAuthRouting(threadId);
  if (routing.available === false) {
    return {
      args,
      error: `OAuth account routing is unavailable. Retry ${publisherSlug}/${toolName} after connected accounts finish loading; refusing to use a default account.`,
    };
  }

  const ambiguity = routing.ambiguous[publisherSlug];
  if (ambiguity) {
    return { args, error: ambiguity };
  }

  const connectionId = routing.publishers[publisherSlug];
  if (connectionId) {
    return { args: { ...args, connection_id: connectionId } };
  }

  return { args };
}

/**
 * Request user approval for a shell command execution.
 * All shell commands require approval — there is no bypass.
 */
async function requestShellApproval(
  command: string,
  timeoutSecs: number,
  link?: ApprovalLink,
  leaseCommand?: string,
): Promise<GatewayApprovalResult> {
  const approvalId = `shell-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  console.log(
    `[Tool Executor] Requesting shell approval (ID: ${approvalId}): ${command}`,
  );

  try {
    await emit("shell-command-approval-request", {
      approvalId,
      command,
      // When the displayed command is a preview, the gate authorized a
      // different string; carry it so the modal's task-lease program key
      // matches the gate's command-rule (see the skill-script call site).
      leaseCommand: leaseCommand ?? command,
      timeoutSecs,
      threadId: link?.threadId ?? conversationStore.activeConversationId,
      continuationId: link?.continuationId,
    });
  } catch (err) {
    console.error(
      "[Tool Executor] Failed to emit shell approval request:",
      err,
    );
    return { approved: false };
  }

  return new Promise((resolve) => {
    let unlisten: UnlistenFn | undefined;
    const timeout = setTimeout(() => {
      console.log(`[Tool Executor] Shell approval timeout for ${approvalId}`);
      unlisten?.();
      // Dismiss the shell approval dialog on expiry rather than leaving it open
      // over an action the executor has already abandoned.
      void emit("shell-command-approval-response", {
        id: approvalId,
        approved: false,
        expired: true,
      });
      resolve({ approved: false, timedOut: true });
    }, SHELL_APPROVAL_TIMEOUT_MS);

    listen<{ id: string; approved: boolean; skipped?: boolean }>(
      "shell-command-approval-response",
      (event) => {
        if (event.payload.id !== approvalId) return;
        console.log(
          `[Tool Executor] Shell approval response: ${event.payload.approved}`,
        );
        clearTimeout(timeout);
        unlisten?.();
        resolve({
          approved: event.payload.approved,
          skipped: event.payload.skipped ?? false,
        });
      },
    )
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error(
          "[Tool Executor] Failed to listen for shell approval:",
          err,
        );
        clearTimeout(timeout);
        resolve({ approved: false });
      });
  });
}

/**
 * Execute a single tool call and return the result.
 * Routes to MCP servers or file tools based on prefix.
 */
export async function executeTool(
  toolCall: ToolCall,
  conversationId: string | null = null,
): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function;

  try {
    const args = (argsJson ? JSON.parse(argsJson) : {}) as Record<
      string,
      unknown
    >;

    // Check if this is a built-in Seren tool (seren__toolName)
    if (name.startsWith("seren__")) {
      const serenToolName = name.slice("seren__".length);
      // `call_publisher` is an envelope around a publisher operation. It is
      // authorized and dispatched AS that operation (#3193-F): the transport
      // unwraps the envelope to verify the dispatch handle, and classifying
      // the wrapped operation directly means a high-risk publisher call
      // cannot ride an "unclassified call_publisher" session grant.
      if (serenToolName === "call_publisher") {
        const publisher =
          typeof args.publisher === "string" ? args.publisher : "";
        const tool = typeof args.tool === "string" ? args.tool : "";
        const toolArgs =
          args.tool_args &&
          typeof args.tool_args === "object" &&
          !Array.isArray(args.tool_args)
            ? (args.tool_args as Record<string, unknown>)
            : {};
        if (!publisher || !tool) {
          return {
            tool_call_id: toolCall.id,
            content:
              "call_publisher requires string `publisher` and `tool` arguments",
            is_error: true,
          };
        }
        return await executeGatewayTool(
          toolCall.id,
          publisher,
          tool,
          toolArgs,
          conversationId,
        );
      }
      const auth = await authorizeToolOperation(
        "seren",
        "seren",
        serenToolName,
        args,
        conversationId,
        toolCall.id,
      );
      if (!auth.approved) {
        return auth.toolResult;
      }
      const response = await callSerenTool(serenToolName, args, auth.handle);
      const content =
        typeof response.result === "string"
          ? response.result
          : JSON.stringify(response.result);
      return {
        tool_call_id: toolCall.id,
        content,
        is_error: response.is_error,
      };
    }

    // Check if this is a Seren Gateway tool call (gateway__publisher__toolName)
    const gatewayInfo = parseGatewayToolName(name);
    if (gatewayInfo) {
      return await executeGatewayTool(
        toolCall.id,
        gatewayInfo.publisherSlug,
        gatewayInfo.toolName,
        args,
        conversationId,
      );
    }

    // Check if this is a local MCP tool call (mcp__server__toolName)
    const mcpInfo = parseMcpToolName(name);
    if (mcpInfo) {
      return await executeMcpTool(
        toolCall.id,
        mcpInfo.serverName,
        mcpInfo.toolName,
        args,
        conversationId,
      );
    }

    // Model-originated file tools must execute in the Rust worker, where the
    // canonical project-root policy is enforced before invoking Tauri file
    // commands. Refuse any legacy/frontend-routed copy instead of bypassing it.
    if (
      [
        "read_file",
        "read_file_base64",
        "list_directory",
        "write_file",
        "write_pdf_from_html",
        "path_exists",
        "create_directory",
      ].includes(name)
    ) {
      throw new Error(
        "Local file tools must execute through the protected backend worker",
      );
    }

    // Otherwise, handle non-file local tools.
    let result: unknown;

    switch (name) {
      case "seren_web_fetch": {
        // Arbitrary-URL fetch is open-world data egress; gate it before egress.
        const auth = await authorizeToolOperation(
          "web",
          "seren",
          "web_fetch",
          args,
          conversationId,
          toolCall.id,
        );
        if (!auth.approved) {
          return auth.toolResult;
        }

        const url = args.url as string;
        const timeoutMs = args.timeout_ms as number | undefined;
        const response = await invoke<{
          content: string;
          content_type: string;
          url: string;
          status: number;
          truncated: boolean;
        }>("web_fetch", { url, timeoutMs, authHandle: auth.handle });

        if (response.status >= 400) {
          result = `Error: HTTP ${response.status} for ${response.url}`;
        } else {
          result = response.content;
        }
        break;
      }

      case "execute_command": {
        const command = args.command as string;
        if (!command || typeof command !== "string") {
          throw new Error("Invalid command: must be a non-empty string");
        }
        const timeoutSecs = (args.timeout_secs as number) ?? 30;
        const invokeArgs: {
          command: string;
          timeoutSecs: number;
          injectSerenCredentials?: boolean;
          toolCallId: string;
        } = { command, timeoutSecs, toolCallId: toolCall.id };
        if (typeof args.inject_seren_credentials === "boolean") {
          invokeArgs.injectSerenCredentials = args.inject_seren_credentials;
        }

        const auth = await authorizeSubprocess(
          "shell",
          "execute_command",
          command,
          args,
          conversationId,
          toolCall.id,
          (link) => requestShellApproval(command, timeoutSecs, link),
        );
        if (!auth.approved) {
          return auth.toolResult;
        }

        // Backs the Tail / LIVE pane (#2100). Idempotent — first call
        // attaches the global subscription, subsequent ones await zero
        // work. Awaited so a chunk emitted before the bridge is up
        // doesn't get dropped.
        await startShellProgressListener();

        const cmdResult = await invoke<{
          stdout: string;
          stderr: string;
          exit_code: number | null;
          timed_out: boolean;
        }>("execute_shell_command_streaming", {
          ...invokeArgs,
          authHandle: auth.handle,
        });

        if (cmdResult.timed_out) {
          result = `Command timed out after ${timeoutSecs} seconds.\nstderr: ${cmdResult.stderr}`;
        } else {
          const parts: string[] = [];
          if (cmdResult.stdout) parts.push(`stdout:\n${cmdResult.stdout}`);
          if (cmdResult.stderr) parts.push(`stderr:\n${cmdResult.stderr}`);
          parts.push(`exit_code: ${cmdResult.exit_code ?? "unknown"}`);
          result = parts.join("\n\n");
        }
        break;
      }

      case "run_skill_script": {
        const skillSlug = args.skill_slug as string;
        const cwd = args.cwd as string;
        const argv = args.argv as unknown;
        if (!skillSlug || typeof skillSlug !== "string") {
          throw new Error("Invalid skill_slug: must be a non-empty string");
        }
        if (!cwd || typeof cwd !== "string") {
          throw new Error("Invalid cwd: must be a non-empty string");
        }
        if (
          !Array.isArray(argv) ||
          argv.length === 0 ||
          argv.some((item) => typeof item !== "string" || item.length === 0)
        ) {
          throw new Error("Invalid argv: must be a non-empty string array");
        }
        const timeoutSecs = (args.timeout_secs as number) ?? 30;
        const preview = `${cwd}> ${argv.map((item) => JSON.stringify(item)).join(" ")}`;
        // The lease's command rules match the skill's leading program token, so
        // pass the raw argv (not the cwd-prefixed preview) as the command.
        const auth = await authorizeSubprocess(
          "skill",
          "run_skill_script",
          argv.join(" "),
          args,
          conversationId,
          toolCall.id,
          (link) =>
            requestShellApproval(preview, timeoutSecs, link, argv.join(" ")),
        );
        if (!auth.approved) {
          return auth.toolResult;
        }

        const invokeArgs: {
          skillSlug: string;
          cwd: string;
          argv: string[];
          env?: Record<string, string>;
          timeoutSecs: number;
          injectSerenCredentials?: boolean;
        } = {
          skillSlug,
          cwd,
          argv,
          timeoutSecs,
        };
        if (
          args.env &&
          typeof args.env === "object" &&
          !Array.isArray(args.env)
        ) {
          invokeArgs.env = args.env as Record<string, string>;
        }
        if (typeof args.inject_seren_credentials === "boolean") {
          invokeArgs.injectSerenCredentials = args.inject_seren_credentials;
        }

        const cmdResult = await invoke<{
          stdout: string;
          stderr: string;
          exit_code: number | null;
          timed_out: boolean;
        }>("run_skill_script", { ...invokeArgs, authHandle: auth.handle });

        if (cmdResult.timed_out) {
          result = `Skill script timed out after ${timeoutSecs} seconds.\nstderr: ${cmdResult.stderr}`;
        } else {
          const parts: string[] = [];
          if (cmdResult.stdout) parts.push(`stdout:\n${cmdResult.stdout}`);
          if (cmdResult.stderr) parts.push(`stderr:\n${cmdResult.stderr}`);
          parts.push(`exit_code: ${cmdResult.exit_code ?? "unknown"}`);
          result = parts.join("\n\n");
        }
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    const resultContent =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return {
      tool_call_id: toolCall.id,
      content: truncateToolResult(resultContent),
      is_error: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Tool failures are an expected agent outcome, surfaced to the model as an
    // is_error result — not an app defect. Not reportable.
    console.warn(`[Tool Executor] Tool "${name}" failed:`, message);
    return {
      tool_call_id: toolCall.id,
      content: `Error: ${message}`,
      is_error: true,
    };
  }
}

/**
 * Execute an MCP tool call via the MCP client (local stdio servers).
 */
async function executeMcpTool(
  toolCallId: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  conversationId: string | null,
): Promise<ToolResult> {
  try {
    // The "mcp" route tells the host gate this is a local stdio server: its
    // name is user-controlled and carries no trusted metadata, so its reads are
    // never auto-trusted even when the name resembles a publisher slug.
    const auth = await authorizeToolOperation(
      "mcp",
      serverName,
      toolName,
      args,
      conversationId,
      toolCallId,
    );
    if (!auth.approved) {
      return auth.toolResult;
    }

    const result = await mcpClient.callTool(
      serverName,
      {
        name: toolName,
        arguments: args,
      },
      { authHandle: auth.handle },
    );

    // Convert MCP result content to string
    let content = "";
    for (const item of result.content) {
      if (item.type === "text") {
        content += item.text;
      } else if (item.type === "image") {
        content += `[Image: ${item.mimeType}]`;
      } else if (item.type === "resource") {
        content += item.resource.text || `[Resource: ${item.resource.uri}]`;
      }
    }

    return {
      tool_call_id: toolCallId,
      content: truncateToolResult(content || "Tool executed successfully"),
      is_error: result.isError ?? false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Expected agent outcome (surfaced as an is_error result). Not reportable.
    console.warn(
      `[Tool Executor] MCP tool "${serverName}/${toolName}" failed:`,
      message,
    );
    return {
      tool_call_id: toolCallId,
      content: `MCP tool error: ${message}`,
      is_error: true,
    };
  }
}

/**
 * Extract PaymentRequirements from proxy payment info.
 */
function extractPaymentRequirements(
  proxyInfo: PaymentProxyInfo,
): PaymentRequirements | null {
  // Try parsing from payment_requirements first (the body JSON)
  if (proxyInfo.payment_requirements) {
    try {
      return parsePaymentRequirements(
        JSON.stringify(proxyInfo.payment_requirements),
      );
    } catch {
      // Fall through to try header
    }
  }

  // Try parsing from the PAYMENT-REQUIRED header (base64-encoded)
  if (proxyInfo.payment_required_header) {
    try {
      const decoded = atob(proxyInfo.payment_required_header);
      return parsePaymentRequirements(decoded);
    } catch {
      // Failed to decode/parse header
    }
  }

  return null;
}

/**
 * Execute a gateway tool call via the MCP Gateway.
 * Handles x402 payment proxy flow: if server returns payment requirements,
 * signs the payment locally and retries with _x402_payment parameter.
 */
async function executeGatewayTool(
  toolCallId: string,
  publisherSlug: string,
  toolName: string,
  args: Record<string, unknown>,
  conversationId: string | null,
): Promise<ToolResult> {
  try {
    let callArgs = args;

    const auth = await authorizeToolOperation(
      "gateway",
      publisherSlug,
      toolName,
      args,
      conversationId,
      toolCallId,
    );
    if (!auth.approved) {
      console.log("[Tool Executor] Operation blocked before execution");
      return auth.toolResult;
    }
    // One authorization covers the initial dispatch plus its x402 payment
    // retries — the host-minted handle carries that exact allowance.
    const authHandle = auth.handle;

    if (auth.connectionId) {
      callArgs = { ...args, connection_id: auth.connectionId };
    }

    const resolvedArgs = await resolveGatewayOAuthConnectionArgs(
      publisherSlug,
      toolName,
      callArgs,
      conversationId,
    );
    if (resolvedArgs.error) {
      return {
        tool_call_id: toolCallId,
        content: resolvedArgs.error,
        is_error: true,
      };
    }
    callArgs = resolvedArgs.args;

    const response = await callGatewayTool(
      publisherSlug,
      toolName,
      callArgs,
      authHandle,
    );

    // Check if this is a payment proxy response (requires client-side signing)
    if (response.is_error && response.payment_proxy) {
      console.log(
        "[Tool Executor] Payment proxy detected, attempting local signing...",
      );

      const requirements = extractPaymentRequirements(response.payment_proxy);
      if (!requirements) {
        return {
          tool_call_id: toolCallId,
          content:
            "Payment required but could not parse payment requirements from server response",
          is_error: true,
        };
      }

      // Meter the realized cost against the covering lease's monetary budget
      // BEFORE any payment is signed (#3193-G). The 402 is the first point the
      // real price is known, so this is where the host-owned budget is charged.
      const charge = resolvePaymentCharge(requirements);
      if (!charge) {
        return {
          tool_call_id: toolCallId,
          content:
            "Payment required but the charge amount could not be determined; refusing to pay an indeterminable cost.",
          is_error: true,
        };
      }
      // Match the same context the initial authorize used (the original args,
      // before OAuth connection_id resolution) so the charge lands on the exact
      // lease that authorized this call.
      const leaseContext = contextForPublisherRoute("gateway", args);
      const reservation = await reserveLeaseSpend(
        publisherSlug,
        toolName,
        sessionConversationId(conversationId),
        leaseContext,
        charge.micros,
        charge.asset,
      );
      // Over budget (or a mismatched asset) under a lease → force an explicit
      // prompt so an over-budget payment is never signed silently. Within budget
      // → the reservation is charged and settled once the payment resolves. No
      // lease → the x402 approval UI remains the gate, exactly as before.
      const requireApproval = reservation.outcome === "escalate";
      const reservationId =
        reservation.outcome === "charged"
          ? (reservation.reservationId ?? null)
          : null;

      // Use the x402 service to handle payment (shows UI, signs, etc.)
      const paymentResult = await x402Service.handlePaymentRequired(
        `seren-gateway/${publisherSlug}`,
        toolName,
        new Error(JSON.stringify(response.payment_proxy)),
        { requireApproval },
      );

      if (!paymentResult?.success) {
        // The payment never completed — release the reserved budget so a
        // cancelled or failed payment does not permanently consume the lease.
        if (reservationId) {
          await settleLeaseSpend(reservationId, null);
        }
        return {
          tool_call_id: toolCallId,
          content: paymentResult?.error || "Payment was cancelled or failed",
          is_error: true,
        };
      }

      // Payment committed: finalize the reservation once (keeps the charge; a
      // delta only arises if a pre-call estimate was reserved earlier).
      if (reservationId) {
        await settleLeaseSpend(reservationId, charge.micros);
      }

      // If crypto payment was signed, retry with the payment header
      if (paymentResult.paymentHeader) {
        console.log("[Tool Executor] Retrying with signed payment...");

        const retryArgs = {
          ...callArgs,
          _x402_payment: paymentResult.paymentHeader,
        };

        const retryResponse = await callGatewayTool(
          publisherSlug,
          toolName,
          retryArgs,
          authHandle,
        );

        const retryContent =
          typeof retryResponse.result === "string"
            ? retryResponse.result
            : JSON.stringify(retryResponse.result, null, 2);

        return {
          tool_call_id: toolCallId,
          content: truncateToolResult(
            retryContent || "Tool executed successfully with payment",
          ),
          is_error: retryResponse.is_error,
        };
      }

      // SerenBucks payment - server handles it via auth token
      // Just retry the original call (auth token is always sent)
      if (paymentResult.method === "serenbucks") {
        console.log(
          "[Tool Executor] SerenBucks selected, retrying (server uses auth token)...",
        );

        // For SerenBucks, we might need to add a flag to indicate user confirmed
        // For now, just retry - the server should accept prepaid if available
        const retryResponse = await callGatewayTool(
          publisherSlug,
          toolName,
          callArgs,
          authHandle,
        );

        const retryContent =
          typeof retryResponse.result === "string"
            ? retryResponse.result
            : JSON.stringify(retryResponse.result, null, 2);

        return {
          tool_call_id: toolCallId,
          content: truncateToolResult(
            retryContent || "Tool executed successfully",
          ),
          is_error: retryResponse.is_error,
        };
      }
    }

    // Convert result to string content
    const content =
      typeof response.result === "string"
        ? response.result
        : JSON.stringify(response.result, null, 2);

    // Check for OAuth token errors in the response
    if (response.is_error && isOAuthTokenError(content)) {
      notifyOAuthExpired(publisherSlug, content);
    }

    return {
      tool_call_id: toolCallId,
      content: truncateToolResult(content || "Tool executed successfully"),
      is_error: response.is_error,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Expected agent outcome (surfaced as an is_error result). Not reportable.
    console.warn(
      `[Tool Executor] Gateway tool "${publisherSlug}/${toolName}" failed:`,
      message,
    );

    // Check for OAuth token errors and notify the UI
    if (isOAuthTokenError(message)) {
      notifyOAuthExpired(publisherSlug, message);
    }

    return {
      tool_call_id: toolCallId,
      content: `Gateway tool error: ${message}`,
      is_error: true,
    };
  }
}

/**
 * Execute multiple tool calls in parallel.
 */
export async function executeTools(
  toolCalls: ToolCall[],
  conversationId: string | null = null,
): Promise<ToolResult[]> {
  return Promise.all(
    toolCalls.map((toolCall) => executeTool(toolCall, conversationId)),
  );
}
