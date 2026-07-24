// ABOUTME: Classifies Gateway/built-in tool operations for the renderer authorization gate.
// ABOUTME: Uses the operation's structural verb token, not hardcoded per-publisher path patterns.

/**
 * Approval requirement for a specific operation.
 */
export interface ApprovalRequirement {
  /** Publisher slug (e.g., "gmail") */
  publisherSlug: string;
  /** Tool/operation name (the Gateway operationId, e.g. "delete_messages_by_message_id") */
  toolPattern: string;
  /** Human-readable description of what this operation does */
  description: string;
  /** Whether this is a destructive operation (higher warning level) */
  isDestructive?: boolean;
}

/**
 * Authorization behavior for a Gateway, built-in Seren, or local MCP operation.
 * Unknown operations intentionally remain unclassified until trusted metadata exists.
 */
export type OperationClass = "trusted-read" | "high-risk" | "unclassified";

interface OperationPattern {
  publisherSlug: string;
  toolPattern: string;
}

/**
 * Explicit high-risk operations that carry a specific approval description.
 *
 * These are matched against the Gateway's real operationId tool names. Structural
 * classification (see classifyGatewayOperation) already escalates deletes and sends,
 * so this list exists to enrich the approval prompt, not to be the only defense.
 */
export const APPROVAL_REQUIREMENTS: ApprovalRequirement[] = [
  {
    publisherSlug: "gmail",
    toolPattern: "delete_messages_by_message_id",
    description: "Permanently delete email",
    isDestructive: true,
  },
  {
    publisherSlug: "gmail",
    toolPattern: "delete_labels_by_label_id",
    description: "Delete label",
    isDestructive: true,
  },
  {
    publisherSlug: "gmail",
    toolPattern: "post_send",
    description: "Send email",
  },
  {
    publisherSlug: "gmail",
    toolPattern: "post_messages_send",
    description: "Send email (raw RFC 2822)",
  },
  {
    publisherSlug: "gmail",
    toolPattern: "post_drafts_by_draft_id_send",
    description: "Send draft email",
  },
];

/**
 * Publisher-scoped read trust. Reads (safe verb tokens, see READ_VERBS) for these
 * publishers execute silently. Reads for any other publisher stay unclassified —
 * we do not assume an unknown or dynamically discovered publisher's reads are safe.
 */
export const TRUSTED_READ_PUBLISHERS: ReadonlySet<string> = new Set(["gmail"]);

/**
 * Positively identified read-only operations for publishers not covered by
 * TRUSTED_READ_PUBLISHERS. Keep this list narrow: verb-shaped names and
 * undiscovered publishers do not become trusted merely because they look like reads.
 */
export const TRUSTED_READ_OPERATIONS: readonly OperationPattern[] = [
  { publisherSlug: "seren", toolPattern: "list_projects" },
  { publisherSlug: "seren", toolPattern: "get_project" },
  { publisherSlug: "seren", toolPattern: "search_projects" },
  { publisherSlug: "seren", toolPattern: "get_status" },
];

/**
 * Leading verb tokens that denote a side-effect-free read. Gateway operationIds
 * are `{httpMethod}_{path}`, so a `get_`/`head_` prefix is a genuine HTTP GET/HEAD.
 * The remaining verbs cover CRUD-style and RPC-style read names.
 */
const READ_VERBS: ReadonlySet<string> = new Set([
  "get",
  "head",
  "list",
  "search",
  "describe",
  "read",
  "fetch",
  "query",
  "count",
  "find",
  "lookup",
  "check",
  "view",
  "show",
  "poll",
  "status",
  "info",
  "ping",
  "health",
  "has",
  "is",
  "exists",
]);

/**
 * Tokens that mark an operation as high-risk: irreversible, monetary, outbound,
 * or credential/security sensitive. Matched as whole underscore/space-delimited
 * tokens so `get_messages` is never flagged by the word "messages" — only real
 * verbs like `send`, `delete`, `transfer`, or `order` count.
 */
const HIGH_RISK_TOKENS: ReadonlySet<string> = new Set([
  // irreversible / destructive
  "delete",
  "destroy",
  "drop",
  "purge",
  "terminate",
  "wipe",
  "erase",
  "remove",
  "revoke",
  // monetary / trading
  "pay",
  "payment",
  "payout",
  "withdraw",
  "withdrawal",
  "deposit",
  "transfer",
  "remit",
  "trade",
  "order",
  "buy",
  "sell",
  "charge",
  "refund",
  "settle",
  "settlement",
  "swap",
  "mint",
  "burn",
  "bet",
  "wager",
  "stake",
  // outbound
  "send",
  "email",
  "sms",
  "notify",
  "dispatch",
  "broadcast",
  // credential / security / execution
  "credential",
  "secret",
  "password",
  "sign",
  "execute",
  "deploy",
]);

function isHighRiskToken(token: string): boolean {
  if (HIGH_RISK_TOKENS.has(token)) return true;
  // Light singularization so plurals like "orders" or "transfers" still match
  // "order" / "transfer".
  return token.endsWith("s") && HIGH_RISK_TOKENS.has(token.slice(0, -1));
}

function operationTokens(toolName: string): string[] {
  return toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function leadingVerb(toolName: string): string {
  return operationTokens(toolName)[0] ?? "";
}

function matchesOperation(
  requirement: OperationPattern,
  publisherSlug: string,
  toolName: string,
): boolean {
  if (requirement.publisherSlug !== publisherSlug) return false;

  // Simple wildcard matching: "messages/*/delete" matches "messages/123/delete"
  // without allowing a wildcard to span a path segment. Live operationIds are
  // literal (path parameters are call arguments), so most patterns match exactly.
  const pattern = requirement.toolPattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${pattern}$`).test(toolName);
}

/**
 * Whether the operation is a read. Reads are never high-risk: the read verb gates
 * the high-risk token scan so an operation like `get_transfers` (reading transfers)
 * is not mistaken for a money movement.
 */
export function isReadOperation(toolName: string): boolean {
  return READ_VERBS.has(leadingVerb(toolName));
}

/**
 * Escalate operations whose verb marks them irreversible, monetary, outbound, or
 * credential-sensitive. This only adds approvals; it never grants access, and it
 * never fires for a read operation.
 */
export function isHighRiskOperation(toolName: string): boolean {
  if (isReadOperation(toolName)) return false;
  return operationTokens(toolName).some(isHighRiskToken);
}

/**
 * Classify an operation by its structural verb token plus explicit policy entries.
 * Precedence is deny-safe: high-risk is decided before trusted-read, and anything
 * unrecognized stays unclassified rather than implicitly safe.
 */
export function classifyGatewayOperation(
  publisherSlug: string,
  toolName: string,
): OperationClass {
  if (
    APPROVAL_REQUIREMENTS.some((requirement) =>
      matchesOperation(requirement, publisherSlug, toolName),
    )
  ) {
    return "high-risk";
  }

  if (isHighRiskOperation(toolName)) {
    return "high-risk";
  }

  const trustedRead =
    (TRUSTED_READ_PUBLISHERS.has(publisherSlug) && isReadOperation(toolName)) ||
    TRUSTED_READ_OPERATIONS.some((operation) =>
      matchesOperation(operation, publisherSlug, toolName),
    );
  if (trustedRead) {
    return "trusted-read";
  }

  return "unclassified";
}

/**
 * Check if a Gateway tool call requires user approval.
 */
export function requiresApproval(
  publisherSlug: string,
  toolName: string,
): boolean {
  return classifyGatewayOperation(publisherSlug, toolName) === "high-risk";
}

/**
 * Get the approval requirement details for a specific operation.
 */
export function getApprovalRequirement(
  publisherSlug: string,
  toolName: string,
): ApprovalRequirement | null {
  const req = APPROVAL_REQUIREMENTS.find((req) => {
    return matchesOperation(req, publisherSlug, toolName);
  });

  return req || null;
}
