// ABOUTME: Agent task service for running and managing cloud agent tasks.
// ABOUTME: Provides API calls for task lifecycle and SSE streaming.

import { API_BASE } from "@/lib/config";
import { getToken } from "@/services/auth";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentTaskStatus =
  | "pending"
  | "submitted"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled";

export interface AgentTask {
  id: string;
  organization_id: string;
  publisher_id: string;
  user_id: string;
  status: AgentTaskStatus;
  trigger_type: string;
  input_message: Record<string, unknown>;
  output?: Record<string, unknown>;
  error_message?: string;
  a2a_task_id?: string;
  cost_compute_atomic: number;
  cost_tool_atomic: number;
  cost_llm_atomic: number;
  cost_total_atomic: number;
  cost_cap_atomic?: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface AgentTaskEvent {
  id: string;
  task_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function authHeaders(): Promise<HeadersInit> {
  const token = await getToken();
  if (!token) throw new Error("Not authenticated");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function apiGet<T>(path: string): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: await authHeaders(),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${body}`);
  }
  const json = await resp.json();
  return json.data;
}

async function apiPost<T>(
  path: string,
  body?: unknown,
): Promise<{ data: T; status: number }> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: await authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok && resp.status !== 202) {
    const text = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  return { data: json.data, status: resp.status };
}

// ── API Functions ────────────────────────────────────────────────────────────

/**
 * Run an agent via the publisher proxy. Returns 202 with task details.
 */
export async function runAgentCloud(
  publisherSlug: string,
  message: unknown,
): Promise<AgentTask> {
  const { data } = await apiPost<AgentTask>(
    `/publishers/${publisherSlug}`,
    message,
  );
  return data;
}

/**
 * List agent tasks for an organization.
 */
export async function listAgentTasks(
  orgId: string,
  limit = 20,
  offset = 0,
): Promise<AgentTask[]> {
  return apiGet<AgentTask[]>(
    `/organizations/${orgId}/agents/tasks?limit=${limit}&offset=${offset}`,
  );
}

/**
 * Get a specific agent task.
 */
export async function getAgentTask(
  orgId: string,
  taskId: string,
): Promise<AgentTask> {
  return apiGet<AgentTask>(`/organizations/${orgId}/agents/tasks/${taskId}`);
}

/**
 * Cancel a running agent task.
 */
export async function cancelAgentTask(
  orgId: string,
  taskId: string,
): Promise<AgentTask> {
  const { data } = await apiPost<AgentTask>(
    `/organizations/${orgId}/agents/tasks/${taskId}/cancel`,
  );
  return data;
}

/**
 * Get task events (historical).
 */
export async function getTaskEvents(
  orgId: string,
  taskId: string,
): Promise<AgentTaskEvent[]> {
  return apiGet<AgentTaskEvent[]>(
    `/organizations/${orgId}/agents/tasks/${taskId}/events`,
  );
}

/**
 * Stream task events via SSE. Returns a handle that can be closed.
 * Uses fetch-based SSE since EventSource doesn't support auth headers.
 */
export function streamTask(
  orgId: string,
  taskId: string,
  callbacks: {
    onEvent: (eventType: string, data: Record<string, unknown>) => void;
    onComplete: (task: Partial<AgentTask>) => void;
    onError: (error: string) => void;
  },
): { close: () => void } {
  const url = `${API_BASE}/organizations/${orgId}/agents/tasks/${taskId}/stream`;
  let aborted = false;

  (async () => {
    try {
      const headers = await authHeaders();
      const resp = await fetch(url, {
        headers: { ...headers, Accept: "text/event-stream" },
      });

      if (!resp.ok || !resp.body) {
        callbacks.onError(`Stream failed: ${resp.status}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes("\n\n")) {
          const end = buffer.indexOf("\n\n");
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);

          let eventType = "";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data = line.slice(5).trim();
            }
          }

          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            callbacks.onEvent(eventType, parsed);

            if (eventType === "task.completed") {
              callbacks.onComplete(parsed);
              return;
            }
          } catch {
            // Skip unparseable events
          }
        }
      }
    } catch (err) {
      if (!aborted) {
        callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    }
  })();

  return {
    close: () => {
      aborted = true;
    },
  };
}

/**
 * Check if a task status is terminal (no more updates expected).
 */
export function isTerminalStatus(status: AgentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
