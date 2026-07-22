// ABOUTME: In-memory, session-bounded grants and denials for tool authorization.
// ABOUTME: Decisions are deliberately not persisted because incomplete metadata is never durable authority.

type SessionDecision = "granted" | "denied";

const sessionDecisions = new Map<string, SessionDecision>();

function decisionKey(
  conversationId: string,
  publisherSlug: string,
  toolName: string,
): string {
  return JSON.stringify([conversationId, publisherSlug, toolName]);
}

export function hasSessionGrant(
  conversationId: string,
  publisherSlug: string,
  toolName: string,
): boolean {
  return (
    sessionDecisions.get(
      decisionKey(conversationId, publisherSlug, toolName),
    ) === "granted"
  );
}

export function recordSessionGrant(
  conversationId: string,
  publisherSlug: string,
  toolName: string,
): void {
  sessionDecisions.set(
    decisionKey(conversationId, publisherSlug, toolName),
    "granted",
  );
}

export function hasSessionDenial(
  conversationId: string,
  publisherSlug: string,
  toolName: string,
): boolean {
  return (
    sessionDecisions.get(
      decisionKey(conversationId, publisherSlug, toolName),
    ) === "denied"
  );
}

export function recordSessionDenial(
  conversationId: string,
  publisherSlug: string,
  toolName: string,
): void {
  sessionDecisions.set(
    decisionKey(conversationId, publisherSlug, toolName),
    "denied",
  );
}

export function clearSessionDecisions(conversationId: string): void {
  const prefix = JSON.stringify([conversationId]).slice(0, -1);
  for (const key of sessionDecisions.keys()) {
    if (key.startsWith(prefix)) {
      sessionDecisions.delete(key);
    }
  }
}
