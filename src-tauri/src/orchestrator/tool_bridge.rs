// ABOUTME: Bridge for routing non-local tool calls to the frontend for execution.
// ABOUTME: ChatModelWorker registers pending tool calls; frontend submits results.

use std::collections::HashMap;
use tokio::sync::{Mutex, oneshot};

/// Result of a tool execution performed by the frontend.
pub struct ToolExecutionResult {
    pub content: String,
    pub is_error: bool,
}

/// A registered frontend tool call awaiting its result.
///
/// Carries the owning conversation so session cleanup can drop the entries a
/// stopped run left behind (GH #3446).
struct PendingToolCall {
    conversation_id: String,
    tx: oneshot::Sender<ToolExecutionResult>,
}

/// Shared bridge between the Rust ChatModelWorker and the frontend tool executor.
///
/// When ChatModelWorker encounters a non-local tool (gateway__, mcp__),
/// it registers a pending request here and waits. The frontend executes the tool
/// and submits the result via the `submit_tool_result` Tauri command.
pub struct ToolResultBridge {
    pending: Mutex<HashMap<String, PendingToolCall>>,
}

impl ToolResultBridge {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Register a pending tool call. Returns a receiver that the worker awaits.
    pub async fn register(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
    ) -> oneshot::Receiver<ToolExecutionResult> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.pending.lock().await;
        pending.insert(
            tool_call_id.to_string(),
            PendingToolCall {
                conversation_id: conversation_id.to_string(),
                tx,
            },
        );
        rx
    }

    /// Submit a tool result from the frontend. Returns true if a pending request was found.
    pub async fn submit(&self, tool_call_id: &str, content: String, is_error: bool) -> bool {
        let mut pending = self.pending.lock().await;
        if let Some(call) = pending.remove(tool_call_id) {
            let _ = call.tx.send(ToolExecutionResult { content, is_error });
            true
        } else {
            log::warn!(
                "[ToolResultBridge] No pending request for tool_call_id: {}",
                tool_call_id
            );
            false
        }
    }

    /// Remove a pending entry without completing it. Returns whether an entry
    /// existed. Called by the worker's own timeout/error paths, where the
    /// receiver is already gone: leaving the entry would let it linger until
    /// the next main-view reload and silently swallow a stray late
    /// `submit_tool_result` (GH #3446).
    pub async fn remove(&self, tool_call_id: &str) -> bool {
        self.pending.lock().await.remove(tool_call_id).is_some()
    }

    /// Drop every pending entry owned by `conversation_id`, returning how
    /// many were removed. Called from orchestration session cleanup so a run
    /// stopped mid-tool-call does not leak its entries (GH #3446). A worker
    /// still awaiting one of these observes the dropped sender as a closed
    /// channel and reports the call cancelled.
    pub async fn remove_for_conversation(&self, conversation_id: &str) -> usize {
        let mut pending = self.pending.lock().await;
        let before = pending.len();
        pending.retain(|_, call| call.conversation_id != conversation_id);
        before - pending.len()
    }

    /// Abandon every pending frontend tool call, completing each waiting worker
    /// with an explicit interrupted result. Called when the main webview
    /// (re)loads: the renderer that owned these calls — and any approval it was
    /// awaiting — is gone, so `submit_tool_result` can never arrive and a worker
    /// blocked in `execute_frontend_tool` would otherwise wait forever on a
    /// result that will never be sent (an authorization block must never look
    /// like a hung agent). Draining resolves each stranded await so the worker's
    /// turn finishes with the interruption disclosed. Returns how many calls were
    /// drained (0 on a first load, where nothing is pending).
    pub async fn drain(&self) -> usize {
        let mut pending = self.pending.lock().await;
        let drained = pending.len();
        for (_tool_call_id, call) in pending.drain() {
            let _ = call.tx.send(ToolExecutionResult {
                content: INTERRUPTED_RESULT.to_string(),
                is_error: true,
            });
        }
        drained
    }
}

/// The result a worker sees when its pending frontend tool call is abandoned
/// because the renderer that owned it reloaded or crashed. Explicit so the
/// interrupted turn discloses the interruption instead of hanging on a result
/// that will never arrive.
const INTERRUPTED_RESULT: &str = "Tool execution was interrupted because the app view reloaded \
     before the result returned. The action did not complete; ask again to retry.";

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_submit_round_trip() {
        let bridge = ToolResultBridge::new();

        let rx = bridge.register("conv-1", "tc_1").await;

        let submitted = bridge
            .submit("tc_1", "result content".to_string(), false)
            .await;
        assert!(submitted);

        let result = rx.await.unwrap();
        assert_eq!(result.content, "result content");
        assert!(!result.is_error);
    }

    #[tokio::test]
    async fn submit_unknown_id_returns_false() {
        let bridge = ToolResultBridge::new();
        let submitted = bridge
            .submit("nonexistent", "data".to_string(), false)
            .await;
        assert!(!submitted);
    }

    #[tokio::test]
    async fn submit_error_result() {
        let bridge = ToolResultBridge::new();
        let rx = bridge.register("conv-1", "tc_err").await;

        bridge
            .submit("tc_err", "tool failed".to_string(), true)
            .await;

        let result = rx.await.unwrap();
        assert_eq!(result.content, "tool failed");
        assert!(result.is_error);
    }

    #[tokio::test]
    async fn drain_completes_stranded_awaits_instead_of_hanging() {
        // The renderer-loss hang (#3287): a worker registers a pending frontend
        // tool call and awaits its receiver. If the renderer never submits (a
        // reload/crash), the sender lingers and `rx.await` would hang forever.
        // `drain()` — invoked on the main webview's page-load — must complete the
        // await with an explicit interrupted error so the worker's turn finishes.
        let bridge = ToolResultBridge::new();
        let rx_a = bridge.register("conv-1", "tc_a").await;
        let rx_b = bridge.register("conv-2", "tc_b").await;

        let drained = bridge.drain().await;
        assert_eq!(drained, 2, "both stranded calls should be drained");

        for rx in [rx_a, rx_b] {
            let result = rx
                .await
                .expect("drained await resolves rather than hanging");
            assert!(result.is_error, "an interrupted call is an error result");
            assert!(
                result.content.contains("reloaded"),
                "the result discloses the view reload, got: {}",
                result.content
            );
        }

        // A subsequent drain is a harmless no-op (idempotent; first-load safe).
        assert_eq!(bridge.drain().await, 0);
    }

    #[tokio::test]
    async fn remove_deletes_entry_without_completing_it() {
        // GH #3446: the frontend-tool timeout branch removes its own entry so
        // a stray late submit reports "no pending request" instead of being
        // silently swallowed by a dead receiver.
        let bridge = ToolResultBridge::new();
        let rx = bridge.register("conv-1", "tc_timeout").await;
        drop(rx); // the worker's await was consumed by its timeout

        assert!(bridge.remove("tc_timeout").await);
        assert!(!bridge.remove("tc_timeout").await, "second remove is a no-op");
        assert!(
            !bridge.submit("tc_timeout", "late".to_string(), false).await,
            "a late submit must find no entry"
        );
    }

    #[tokio::test]
    async fn remove_for_conversation_purges_only_that_conversation() {
        // GH #3446: orchestration session cleanup drops the entries an
        // aborted run left behind, leaving other conversations' pending calls
        // untouched. A still-alive waiter observes the drop as a closed
        // channel (the worker surfaces it as a cancelled call).
        let bridge = ToolResultBridge::new();
        let rx_a = bridge.register("conv-a", "tc_a").await;
        let rx_a2 = bridge.register("conv-a", "tc_a2").await;
        let rx_b = bridge.register("conv-b", "tc_b").await;

        assert_eq!(bridge.remove_for_conversation("conv-a").await, 2);

        assert!(rx_a.await.is_err(), "purged waiter sees a closed channel");
        assert!(rx_a2.await.is_err());

        // conv-b's call is untouched and still completable.
        assert!(bridge.submit("tc_b", "ok".to_string(), false).await);
        assert_eq!(rx_b.await.unwrap().content, "ok");

        assert_eq!(bridge.remove_for_conversation("conv-a").await, 0);
    }

    #[tokio::test]
    async fn multiple_concurrent_requests() {
        let bridge = ToolResultBridge::new();

        let rx1 = bridge.register("conv-1", "tc_a").await;
        let rx2 = bridge.register("conv-1", "tc_b").await;

        bridge.submit("tc_b", "result_b".to_string(), false).await;
        bridge.submit("tc_a", "result_a".to_string(), false).await;

        let r1 = rx1.await.unwrap();
        let r2 = rx2.await.unwrap();
        assert_eq!(r1.content, "result_a");
        assert_eq!(r2.content, "result_b");
    }
}
