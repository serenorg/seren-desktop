// ABOUTME: Reactive store for computer-use runtime sessions.
// ABOUTME: Manages session lifecycle, events, persistence, and background execution state.

import { createStore } from "solid-js/store";
import {
  addSessionEvent as addSessionEventDb,
  createRuntimeSession as createRuntimeSessionDb,
  deleteRuntimeSession as deleteRuntimeSessionDb,
  getSessionEvents as getSessionEventsDb,
  listRuntimeSessions as listRuntimeSessionsDb,
  resumeRuntimeSession as resumeRuntimeSessionDb,
  updateRuntimeSession as updateRuntimeSessionDb,
  updateSessionEventStatus as updateSessionEventStatusDb,
} from "@/lib/tauri-bridge";
import type {
  RawRuntimeSession,
  RawSessionEvent,
  RuntimeSession,
  SessionContext,
  SessionEnvironment,
  SessionEvent,
  SessionEventMetadata,
  SessionEventStatus,
  SessionEventType,
  SessionPolicy,
  SessionStatus,
} from "@/types/session";
import { parseRuntimeSession, parseSessionEvent } from "@/types/session";

// ============================================================================
// State
// ============================================================================

interface SessionState {
  sessions: RuntimeSession[];
  activeSessionId: string | null;
  events: Record<string, SessionEvent[]>;
  isLoading: boolean;
  error: string | null;
}

const [state, setState] = createStore<SessionState>({
  sessions: [],
  activeSessionId: null,
  events: {},
  isLoading: false,
  error: null,
});

// ============================================================================
// Store
// ============================================================================

export const sessionStore = {
  // === Getters ===

  get sessions(): RuntimeSession[] {
    return state.sessions;
  },

  get activeSessionId(): string | null {
    return state.activeSessionId;
  },

  get activeSession(): RuntimeSession | null {
    if (!state.activeSessionId) return null;
    return state.sessions.find((s) => s.id === state.activeSessionId) ?? null;
  },

  get activeSessionEvents(): SessionEvent[] {
    if (!state.activeSessionId) return [];
    return state.events[state.activeSessionId] ?? [];
  },

  get isLoading(): boolean {
    return state.isLoading;
  },

  get error(): string | null {
    return state.error;
  },

  /** Count of sessions not in completed/error state. */
  get activeSessions(): RuntimeSession[] {
    return state.sessions.filter(
      (s) => s.status !== "completed" && s.status !== "error",
    );
  },

  /** Sessions that are running in the background. */
  get backgroundSessions(): RuntimeSession[] {
    return state.sessions.filter(
      (s) =>
        (s.status === "running" || s.status === "waiting_approval") &&
        s.id !== state.activeSessionId,
    );
  },

  getEventsFor(sessionId: string): SessionEvent[] {
    return state.events[sessionId] ?? [];
  },

  getSessionForThread(threadId: string): RuntimeSession | null {
    return state.sessions.find((s) => s.thread_id === threadId) ?? null;
  },

  // === Actions ===

  async createSession(
    title: string,
    environment: SessionEnvironment,
    options?: {
      threadId?: string;
      projectRoot?: string;
      policy?: SessionPolicy;
    },
  ): Promise<RuntimeSession> {
    const id = crypto.randomUUID();
    const policyJson = options?.policy
      ? JSON.stringify(options.policy)
      : undefined;

    try {
      const raw = await createRuntimeSessionDb(
        id,
        title,
        environment,
        options?.threadId,
        options?.projectRoot,
        policyJson,
      );

      const session = parseRuntimeSession(raw as unknown as RawRuntimeSession);
      setState("sessions", (prev) => [session, ...prev]);
      setState("events", id, []);
      return session;
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Failed to create session";
      setState("error", msg);
      throw error;
    }
  },

  setActiveSession(id: string | null) {
    setState("activeSessionId", id);
  },

  async loadSessions(threadId?: string): Promise<void> {
    setState("isLoading", true);
    try {
      const raw = await listRuntimeSessionsDb(50, threadId);
      const sessions = raw.map((r) =>
        parseRuntimeSession(r as unknown as RawRuntimeSession),
      );
      setState("sessions", sessions);
    } catch (error) {
      console.warn("[SessionStore] Failed to load sessions:", error);
    } finally {
      setState("isLoading", false);
    }
  },

  async loadEvents(sessionId: string): Promise<void> {
    try {
      const raw = await getSessionEventsDb(sessionId);
      const events = raw.map((r) =>
        parseSessionEvent(r as unknown as RawSessionEvent),
      );
      setState("events", sessionId, events);
    } catch (error) {
      console.warn("[SessionStore] Failed to load events:", error);
    }
  },

  async updateSession(
    id: string,
    updates: {
      title?: string;
      status?: SessionStatus;
      context?: SessionContext;
      policy?: SessionPolicy;
      threadId?: string;
    },
  ): Promise<void> {
    try {
      await updateRuntimeSessionDb(id, {
        title: updates.title,
        status: updates.status,
        context: updates.context ? JSON.stringify(updates.context) : undefined,
        policy: updates.policy ? JSON.stringify(updates.policy) : undefined,
        threadId: updates.threadId,
      });

      setState("sessions", (prev) =>
        prev.map((s) => {
          if (s.id !== id) return s;
          return {
            ...s,
            ...(updates.title !== undefined && { title: updates.title }),
            ...(updates.status !== undefined && { status: updates.status }),
            ...(updates.context !== undefined && { context: updates.context }),
            ...(updates.policy !== undefined && { policy: updates.policy }),
            ...(updates.threadId !== undefined && {
              thread_id: updates.threadId,
            }),
            updated_at: Date.now(),
          };
        }),
      );
    } catch (error) {
      console.error("[SessionStore] Failed to update session:", error);
    }
  },

  async resumeSession(id: string): Promise<void> {
    try {
      await resumeRuntimeSessionDb(id);

      setState("sessions", (prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                status: "running" as SessionStatus,
                resumed_at: Date.now(),
                updated_at: Date.now(),
              }
            : s,
        ),
      );

      await this.addEvent(id, "status_change", "Session resumed", {
        metadata: { old_status: "paused", new_status: "running" },
      });
    } catch (error) {
      console.error("[SessionStore] Failed to resume session:", error);
    }
  },

  async pauseSession(id: string): Promise<void> {
    await this.updateSession(id, { status: "paused" });
    await this.addEvent(id, "status_change", "Session paused", {
      metadata: { old_status: "running", new_status: "paused" },
    });
  },

  async completeSession(id: string): Promise<void> {
    await this.updateSession(id, { status: "completed" });
    await this.addEvent(id, "status_change", "Session completed", {
      metadata: { old_status: "running", new_status: "completed" },
    });
  },

  async deleteSession(id: string): Promise<void> {
    try {
      await deleteRuntimeSessionDb(id);
      setState("sessions", (prev) => prev.filter((s) => s.id !== id));

      if (state.activeSessionId === id) {
        setState("activeSessionId", null);
      }

      // Clean up events from memory
      setState("events", id, undefined as unknown as SessionEvent[]);
    } catch (error) {
      console.error("[SessionStore] Failed to delete session:", error);
    }
  },

  async addEvent(
    sessionId: string,
    eventType: SessionEventType,
    title: string,
    options?: {
      content?: string;
      metadata?: SessionEventMetadata;
      status?: SessionEventStatus;
    },
  ): Promise<SessionEvent | null> {
    const eventId = crypto.randomUUID();
    const metadataJson = options?.metadata
      ? JSON.stringify(options.metadata)
      : undefined;

    try {
      const raw = await addSessionEventDb(
        eventId,
        sessionId,
        eventType,
        title,
        options?.content,
        metadataJson,
        options?.status,
      );

      const event = parseSessionEvent(raw as unknown as RawSessionEvent);
      setState("events", sessionId, (prev = []) => [...prev, event]);
      return event;
    } catch (error) {
      console.warn("[SessionStore] Failed to add event:", error);
      return null;
    }
  },

  async updateEventStatus(
    eventId: string,
    sessionId: string,
    status: SessionEventStatus,
  ): Promise<void> {
    try {
      await updateSessionEventStatusDb(eventId, status);

      setState("events", sessionId, (prev = []) =>
        prev.map((e) => (e.id === eventId ? { ...e, status } : e)),
      );
    } catch (error) {
      console.warn("[SessionStore] Failed to update event status:", error);
    }
  },

  /** Clear all state (e.g., on logout). */
  clear() {
    setState({
      sessions: [],
      activeSessionId: null,
      events: {},
      isLoading: false,
      error: null,
    });
  },
};
