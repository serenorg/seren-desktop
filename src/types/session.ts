// ABOUTME: Type definitions for computer-use runtime sessions.
// ABOUTME: Defines session state, events, and environment models.

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "completed"
  | "error"
  | "paused";

export type SessionEnvironment = "browser" | "desktop" | "file";

export type SessionEventType =
  | "navigation"
  | "action"
  | "screenshot"
  | "approval"
  | "content"
  | "command"
  | "error"
  | "status_change";

export type SessionEventStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "completed"
  | "error";

export interface RuntimeSession {
  id: string;
  title: string;
  status: SessionStatus;
  environment: SessionEnvironment;
  context: SessionContext | null;
  policy: SessionPolicy | null;
  thread_id: string | null;
  project_root: string | null;
  created_at: number;
  updated_at: number;
  resumed_at: number | null;
}

export interface SessionContext {
  url?: string;
  page_title?: string;
  app_name?: string;
  file_paths?: string[];
  viewport?: { width: number; height: number };
  cookies_count?: number;
  active_tools?: string[];
}

export interface SessionPolicy {
  auto_approve?: string[];
  require_approval?: string[];
  blocked?: string[];
  max_actions_per_minute?: number;
}

export interface SessionEvent {
  id: string;
  session_id: string;
  event_type: SessionEventType;
  title: string;
  content: string | null;
  metadata: SessionEventMetadata | null;
  status: SessionEventStatus;
  created_at: number;
}

export interface SessionEventMetadata {
  tool_name?: string;
  url?: string;
  screenshot_path?: string;
  duration_ms?: number;
  error_message?: string;
  approval_id?: string;
  old_status?: SessionStatus;
  new_status?: SessionStatus;
}

/** Raw session row from the database (context/policy are JSON strings). */
export interface RawRuntimeSession {
  id: string;
  title: string;
  status: string;
  environment: string;
  context: string | null;
  policy: string | null;
  thread_id: string | null;
  project_root: string | null;
  created_at: number;
  updated_at: number;
  resumed_at: number | null;
}

/** Raw event row from the database (metadata is a JSON string). */
export interface RawSessionEvent {
  id: string;
  session_id: string;
  event_type: string;
  title: string;
  content: string | null;
  metadata: string | null;
  status: string;
  created_at: number;
}

/** Parse raw DB session into typed RuntimeSession. */
export function parseRuntimeSession(raw: RawRuntimeSession): RuntimeSession {
  let context: SessionContext | null = null;
  if (raw.context) {
    try {
      context = JSON.parse(raw.context) as SessionContext;
    } catch {
      // Ignore parse errors
    }
  }

  let policy: SessionPolicy | null = null;
  if (raw.policy) {
    try {
      policy = JSON.parse(raw.policy) as SessionPolicy;
    } catch {
      // Ignore parse errors
    }
  }

  return {
    id: raw.id,
    title: raw.title,
    status: raw.status as SessionStatus,
    environment: raw.environment as SessionEnvironment,
    context,
    policy,
    thread_id: raw.thread_id,
    project_root: raw.project_root,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    resumed_at: raw.resumed_at,
  };
}

/** Parse raw DB event into typed SessionEvent. */
export function parseSessionEvent(raw: RawSessionEvent): SessionEvent {
  let metadata: SessionEventMetadata | null = null;
  if (raw.metadata) {
    try {
      metadata = JSON.parse(raw.metadata) as SessionEventMetadata;
    } catch {
      // Ignore parse errors
    }
  }

  return {
    id: raw.id,
    session_id: raw.session_id,
    event_type: raw.event_type as SessionEventType,
    title: raw.title,
    content: raw.content,
    metadata,
    status: raw.status as SessionEventStatus,
    created_at: raw.created_at,
  };
}
