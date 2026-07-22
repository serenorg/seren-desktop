// ABOUTME: Configuration for Gateway publisher tool approval requirements.
// ABOUTME: Defines which operations need user approval before execution.

/**
 * Approval requirement for a specific operation.
 */
export interface ApprovalRequirement {
  /** Publisher slug (e.g., "gmail") */
  publisherSlug: string;
  /** Tool/endpoint name (e.g., "messages/{id}/delete") */
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
 * Explicit high-risk operations that always require one-shot approval.
 * Operations absent from both this list and TRUSTED_READ_OPERATIONS are
 * unclassified and must be escalated before their first use in a session.
 */
export const APPROVAL_REQUIREMENTS: ApprovalRequirement[] = [
  // Gmail - Modify operations
  {
    publisherSlug: "gmail",
    toolPattern: "messages/*/delete",
    description: "Permanently delete email",
    isDestructive: true,
  },
  {
    publisherSlug: "gmail",
    toolPattern: "messages/*/trash",
    description: "Move email to trash",
  },
  {
    publisherSlug: "gmail",
    toolPattern: "messages/*/modify",
    description: "Modify email labels",
  },
  {
    publisherSlug: "gmail",
    toolPattern: "threads/*/trash",
    description: "Move thread to trash",
  },
  {
    publisherSlug: "gmail",
    toolPattern: "labels",
    description: "Create label",
  },
  {
    publisherSlug: "gmail",
    toolPattern: "labels/*/delete",
    description: "Delete label",
    isDestructive: true,
  },
  {
    publisherSlug: "gmail",
    toolPattern: "drafts/*/send",
    description: "Send draft email",
  },
  {
    publisherSlug: "gmail",
    toolPattern: "messages/send",
    description: "Send email",
  },
];

/**
 * Positively identified read-only operations that may execute silently.
 * Keep this list narrow: verb-shaped names and undiscovered publishers do not
 * become trusted merely because they look like reads.
 */
export const TRUSTED_READ_OPERATIONS: readonly OperationPattern[] = [
  { publisherSlug: "gmail", toolPattern: "messages" },
  { publisherSlug: "gmail", toolPattern: "messages/*" },
  { publisherSlug: "gmail", toolPattern: "threads" },
  { publisherSlug: "gmail", toolPattern: "threads/*" },
  { publisherSlug: "gmail", toolPattern: "labels/list" },
  { publisherSlug: "gmail", toolPattern: "get_messages" },
  { publisherSlug: "gmail", toolPattern: "get_message" },
  { publisherSlug: "gmail", toolPattern: "get_thread" },
  { publisherSlug: "gmail", toolPattern: "list_messages" },
  { publisherSlug: "gmail", toolPattern: "list_threads" },
  { publisherSlug: "gmail", toolPattern: "list_labels" },
  { publisherSlug: "seren", toolPattern: "list_projects" },
  { publisherSlug: "seren", toolPattern: "get_project" },
  { publisherSlug: "seren", toolPattern: "search_projects" },
  { publisherSlug: "seren", toolPattern: "get_status" },
];

function matchesOperation(
  requirement: OperationPattern,
  publisherSlug: string,
  toolName: string,
): boolean {
  if (requirement.publisherSlug !== publisherSlug) return false;

  // Simple wildcard matching: "messages/*/delete" matches
  // "messages/123/delete" without allowing a wildcard to span a path segment.
  const pattern = requirement.toolPattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${pattern}$`).test(toolName);
}

/**
 * Classify an operation only when it has an explicit policy entry.
 * Everything else is deliberately unclassified rather than implicitly safe.
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

  if (
    TRUSTED_READ_OPERATIONS.some((operation) =>
      matchesOperation(operation, publisherSlug, toolName),
    )
  ) {
    return "trusted-read";
  }

  return "unclassified";
}

/**
 * Escalate recognizably high-risk names even before their publisher supplies
 * trusted metadata. This helper only adds prompts; it never grants access.
 */
export function isHighRiskVerb(toolName: string): boolean {
  return /send|delete|remove|pay|transfer|trade|execute|credential|revoke/i.test(
    toolName,
  );
}

/**
 * Check if a Gateway tool call requires user approval.
 */
export function requiresApproval(
  publisherSlug: string,
  toolName: string,
): boolean {
  return (
    classifyGatewayOperation(publisherSlug, toolName) === "high-risk" ||
    isHighRiskVerb(toolName)
  );
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
