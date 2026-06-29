// ABOUTME: Runtime invocation for deployed employee agents via the seren-cloud SDK.
// ABOUTME: Adapts the generated SDK to the shared employees-core run manager.

import {
  createEmployeeRunManager,
  formatToolAuditEvent,
  type RunLiveStateEvent,
  type RunOptions,
  type RunResult,
  runLiveStateLabel,
  STREAM_TERMINAL_EVENTS,
  type StartupWaitEvent,
  type ToolAuditEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@seren/employees-core";
import {
  serenCloudCreateInteractiveSession,
  serenCloudDeploymentRun,
  serenCloudDeploymentRunCancel,
  serenCloudDeploymentRunStream,
  serenCloudGetInteractiveSession,
  serenCloudPostInteractiveSessionMessage,
  serenCloudRun,
} from "@/api/seren-cloud";
import { formatApiError } from "@/lib/api-errors";

export {
  formatToolAuditEvent,
  type RunLiveStateEvent,
  type RunOptions,
  type RunResult,
  runLiveStateLabel,
  type StartupWaitEvent,
  type ToolAuditEvent,
  type ToolCallEvent,
  type ToolResultEvent,
};

const employeeRunManager = createEmployeeRunManager(
  {
    async resolveSessionId({ deploymentId, conversationId, signal }) {
      const session = await serenCloudGetInteractiveSession({
        path: { id: deploymentId, session_id: conversationId },
        query: { message_limit: 1, message_offset: 0 },
        signal,
        throwOnError: false,
      });
      if (session.error || !session.data?.data) {
        if (session.response?.status === 404) return null;
        throw new Error(
          formatApiError(
            session.error,
            session.response,
            "the cloud session endpoint returned an error with no message",
          ),
        );
      }
      const detail = session.data.data.session;
      if (isInactiveSession(detail)) {
        return null;
      }
      return detail.interactive_session_id ?? null;
    },
    async createSession({ deploymentId, conversationId, signal }) {
      const created = await serenCloudCreateInteractiveSession({
        path: { id: deploymentId },
        body: conversationId ? { conversation_id: conversationId } : null,
        signal,
        throwOnError: false,
      });
      if (created.error || !created.data?.data) {
        throw new Error(
          formatApiError(
            created.error,
            created.response,
            "the cloud session endpoint returned an error with no message",
          ),
        );
      }
      return created.data.data;
    },
    async postSessionMessage({
      deploymentId,
      sessionId,
      content,
      clientMessageId,
      idempotencyKey,
      metadata,
      signal,
    }) {
      const posted = await serenCloudPostInteractiveSessionMessage({
        path: { id: deploymentId, session_id: sessionId },
        body: {
          content,
          client_message_id: clientMessageId,
          idempotency_key: idempotencyKey,
          metadata,
        },
        signal,
        throwOnError: false,
      });
      if (posted.error || !posted.data?.data) {
        throw new Error(
          formatApiError(
            posted.error,
            posted.response,
            "the cloud session message endpoint returned an error with no message",
          ),
        );
      }
      return posted.data.data;
    },
    async createRun({ deploymentId, body, signal }) {
      const created = await serenCloudRun({
        path: { id: deploymentId },
        body: body as Parameters<typeof serenCloudRun>[0]["body"],
        signal,
        throwOnError: false,
      });
      if (created.error) {
        throw new Error(
          formatApiError(
            created.error,
            created.response,
            "the cloud trigger returned an error with no message",
          ),
        );
      }
      if (!created.data?.data) {
        throw new Error("the cloud trigger responded with no run payload");
      }
      return created.data.data;
    },
    async getRun({ deploymentId, runId, signal }) {
      const run = await serenCloudDeploymentRun({
        path: { id: deploymentId, run_id: runId },
        signal,
        throwOnError: false,
      });
      if (run.error || !run.data?.data) {
        throw new Error(
          `Failed to read run ${runId}: ${formatApiError(
            run.error,
            run.response,
            "missing run data",
          )}`,
        );
      }
      return run.data.data;
    },
    async streamRun({
      deploymentId,
      runId,
      signal,
      maxRetryAttempts,
      lastEventId,
    }) {
      return (async function* () {
        let resumeEventId = lastEventId ?? null;
        let cleanCloseReconnects = 0;
        while (true) {
          let streamError: unknown;
          let sawTerminalEvent = false;
          // The SSE iterator yields only the parsed payload; pair each yielded
          // payload with the event metadata captured by HeyAPI. A queue (not a
          // single slot) keeps pairing correct even if callbacks ever batch.
          const pendingFrames: Array<{ event?: string; id?: string }> = [];
          const headers: Record<string, string> = {
            Accept: "text/event-stream",
          };
          if (resumeEventId) headers["Last-Event-ID"] = resumeEventId;
          const { stream } = await serenCloudDeploymentRunStream({
            headers,
            onSseEvent(event) {
              if (event.data !== undefined) {
                pendingFrames.push({ event: event.event, id: event.id });
              }
            },
            onSseError(error) {
              streamError = error;
            },
            path: { id: deploymentId, run_id: runId },
            signal,
            sseMaxRetryAttempts: maxRetryAttempts,
            throwOnError: false,
          });
          for await (const data of stream as AsyncIterable<unknown>) {
            streamError = undefined;
            const frame = pendingFrames.shift();
            if (frame?.id) resumeEventId = frame.id;
            if (frame?.event && STREAM_TERMINAL_EVENTS.has(frame.event)) {
              sawTerminalEvent = true;
            }
            yield { event: frame?.event, id: frame?.id, data };
          }
          if (streamError !== undefined) throw streamError;
          // Clean EOF without a terminal frame means the connection dropped
          // mid-run; resume from the last sequence instead of restarting.
          if (sawTerminalEvent || cleanCloseReconnects >= maxRetryAttempts) {
            return;
          }
          cleanCloseReconnects += 1;
        }
      })();
    },
    async cancelRun({ deploymentId, runId }) {
      await serenCloudDeploymentRunCancel({
        path: { id: deploymentId, run_id: runId },
        throwOnError: false,
      });
    },
  },
  {
    onStreamOpenError(error) {
      console.warn(
        "[employees-runtime] Stream open failed, falling back to poll:",
        error,
      );
    },
  },
);

export const cancelEmployeeRun = employeeRunManager.cancelEmployeeRun;
export const runEmployeeMessage = employeeRunManager.runEmployeeMessage;

type SessionStatusDetail = {
  closed_at?: string | null;
  idle_expires_at: string;
  interactive_session_id?: string | null;
  session_id: string;
  status: string;
};

function isInactiveSession(detail: SessionStatusDetail): boolean {
  if (detail.closed_at || isClosedSessionStatus(detail.status)) return true;
  const idleExpiresAt = Date.parse(detail.idle_expires_at);
  return !Number.isNaN(idleExpiresAt) && idleExpiresAt <= Date.now();
}

function isClosedSessionStatus(status: string): boolean {
  switch (status.toLowerCase()) {
    case "closed":
    case "expired":
    case "failed":
    case "cancelled":
    case "canceled":
      return true;
    default:
      return false;
  }
}
