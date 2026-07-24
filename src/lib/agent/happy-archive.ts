// ABOUTME: Pure Happy-origin archive fencing and invalidation planning helpers.
// ABOUTME: Behavior-preserving extraction from agent.store; no store state closure.

/**
 * Monotonic fence for Happy-origin archives. Async list/spawn/reattach work
 * captures an epoch before it starts and may only commit while that epoch is
 * still current and the conversation is not tombstoned.
 */
export class HappyArchiveFence {
  private readonly entries = new Map<
    string,
    { generation: number; archived: boolean }
  >();

  capture(conversationId: string): number {
    return this.entries.get(conversationId)?.generation ?? 0;
  }

  archive(conversationId: string): number {
    const current = this.entries.get(conversationId);
    if (current?.archived) return current.generation;
    const generation = (current?.generation ?? 0) + 1;
    this.entries.set(conversationId, { generation, archived: true });
    return generation;
  }

  isArchived(conversationId: string): boolean {
    return this.entries.get(conversationId)?.archived === true;
  }

  allows(conversationId: string, capturedGeneration: number): boolean {
    const current = this.entries.get(conversationId);
    return (
      (current?.generation ?? 0) === capturedGeneration &&
      current?.archived !== true
    );
  }

  filterVisible<T extends { id: string }>(rows: T[]): T[] {
    return rows.filter((row) => !this.isArchived(row.id));
  }
}

/**
 * Invalidate the frontend immediately after Rust archives an agent
 * conversation. A conversation may own more than one runtime session while a
 * predictive-compaction standby is warming, so every matching session must be
 * removed and tombstoned before a late runtime event can reach the UI.
 */
export function planHappyArchiveInvalidation(
  sessions: Record<
    string,
    {
      conversationId: string;
      role: "serving" | "standby";
      archiveOwnerConversationId?: string;
      standbySessionId?: string | null;
    }
  >,
  activeSessionId: string | null,
  conversationId: string,
): { archivedSessionIds: string[]; nextActiveSessionId: string | null } {
  const archivedSessionIdSet = new Set(
    Object.entries(sessions)
      .filter(
        ([, session]) =>
          session.conversationId === conversationId ||
          session.archiveOwnerConversationId === conversationId,
      )
      .map(([sessionId]) => sessionId),
  );
  // Include a registered warm standby even if it predates the explicit owner
  // field. The serving pointer is the durable sibling relationship until
  // promotion copies the persisted conversation id onto the standby.
  for (const sessionId of [...archivedSessionIdSet]) {
    const standbySessionId = sessions[sessionId]?.standbySessionId;
    if (standbySessionId && sessions[standbySessionId]) {
      archivedSessionIdSet.add(standbySessionId);
    }
  }
  const archivedSessionIds = [...archivedSessionIdSet];
  const nextActiveSessionId =
    activeSessionId && archivedSessionIdSet.has(activeSessionId)
      ? (Object.entries(sessions).find(
          ([sessionId, session]) =>
            !archivedSessionIdSet.has(sessionId) && session.role === "serving",
        )?.[0] ?? null)
      : activeSessionId;
  return { archivedSessionIds, nextActiveSessionId };
}

/**
 * Release the app-wide predictive-compaction mutex only when the archived
 * conversation owns the in-flight warmup. Clearing it for an unrelated
 * archive could allow a second compaction to start concurrently.
 */
export interface HappyArchivedSiblingRetirementResult {
  fenced: boolean;
  retired: boolean;
  forceKilled: boolean;
  lastError?: unknown;
}

/**
 * Retire a sibling of the Happy row archived on mobile. The durable local
 * fence is attempted before process teardown, and the PID-guarded Rust kill is
 * the immediate fallback when the provider runtime cannot service termination.
 */
export async function retireHappyArchivedSiblingProvider(
  sessionId: string,
  pid: number | null | undefined,
  operations: {
    fence: (sessionId: string) => Promise<void>;
    terminate: (sessionId: string) => Promise<void>;
    forceKill: (pid: number) => Promise<boolean>;
  },
): Promise<HappyArchivedSiblingRetirementResult> {
  let fenced = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && !fenced; attempt += 1) {
    try {
      await operations.fence(sessionId);
      fenced = true;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    await operations.terminate(sessionId);
    return { fenced, retired: true, forceKilled: false, lastError };
  } catch (error) {
    lastError = error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return { fenced, retired: true, forceKilled: false, lastError };
    }
  }

  if (pid != null) {
    try {
      const forceKilled = await operations.forceKill(pid);
      if (forceKilled) {
        return { fenced, retired: true, forceKilled: true, lastError };
      }
    } catch (error) {
      lastError = error;
    }
  }
  return { fenced, retired: false, forceKilled: false, lastError };
}

export function planHappyProviderArchiveInvalidation(
  sessions: Record<
    string,
    {
      role: "serving" | "standby";
      standbySessionId?: string | null;
    }
  >,
  activeSessionId: string | null,
  targetProviderSessionId: string,
): {
  archivedSessionIds: string[];
  linkedServingSessionIds: string[];
  nextActiveSessionId: string | null;
} {
  const linkedServingSessionIds = Object.entries(sessions)
    .filter(
      ([sessionId, session]) =>
        sessionId !== targetProviderSessionId &&
        session.role === "serving" &&
        session.standbySessionId === targetProviderSessionId,
    )
    .map(([sessionId]) => sessionId);
  const nextActiveSessionId =
    activeSessionId === targetProviderSessionId
      ? (Object.entries(sessions).find(
          ([sessionId, session]) =>
            sessionId !== targetProviderSessionId && session.role === "serving",
        )?.[0] ?? null)
      : activeSessionId;
  return {
    archivedSessionIds: [targetProviderSessionId],
    linkedServingSessionIds,
    nextActiveSessionId,
  };
}
