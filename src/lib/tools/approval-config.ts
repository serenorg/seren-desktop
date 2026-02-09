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
 * List of Gateway publisher operations that require user approval.
 *
 * Operations not in this list execute immediately (e.g., read-only operations).
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
 * Check if a Gateway tool call requires user approval.
 */
export function requiresApproval(
  publisherSlug: string,
  toolName: string,
): boolean {
  // Check if any approval requirement matches this operation
  return APPROVAL_REQUIREMENTS.some((req) => {
    if (req.publisherSlug !== publisherSlug) return false;

    // Simple wildcard matching: "messages/*/delete" matches "messages/123/delete"
    const pattern = req.toolPattern.replace(/\*/g, "[^/]+");
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(toolName);
  });
}

/**
 * Get the approval requirement details for a specific operation.
 */
export function getApprovalRequirement(
  publisherSlug: string,
  toolName: string,
): ApprovalRequirement | null {
  const req = APPROVAL_REQUIREMENTS.find((req) => {
    if (req.publisherSlug !== publisherSlug) return false;
    const pattern = req.toolPattern.replace(/\*/g, "[^/]+");
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(toolName);
  });

  return req || null;
}
