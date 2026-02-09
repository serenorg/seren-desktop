// ABOUTME: Eval signal service for collecting satisfaction feedback.
// ABOUTME: Queues feature vectors for batch sync to the Gateway API.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// Valid task types that can appear in eval signals
const VALID_TASK_TYPES: &[&str] = &[
    "code_generation",
    "file_operations",
    "research",
    "document_generation",
    "general_chat",
];

/// Feature vector sent to the Gateway (contains NO conversation content).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalSignal {
    pub task_type: String,
    pub model_id: Option<String>,
    pub satisfaction: i32,
    pub worker_type: Option<String>,
    pub delegation_type: Option<String>,
    pub had_tool_errors: bool,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

/// Managed state for the eval signal queue.
pub struct EvalState {
    queue: Mutex<VecDeque<EvalSignal>>,
}

const BATCH_SIZE: usize = 10;

impl EvalState {
    pub fn new() -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
        }
    }

    /// Add a signal to the queue. Flushes if queue reaches batch size.
    pub fn enqueue(&self, signal: EvalSignal) {
        let should_flush = {
            let mut queue = self.queue.lock().unwrap();
            queue.push_back(signal);
            queue.len() >= BATCH_SIZE
        };

        if should_flush {
            self.flush();
        }
    }

    /// Flush the queue (best-effort, drops on failure).
    pub fn flush(&self) {
        let signals: Vec<EvalSignal> = {
            let mut queue = self.queue.lock().unwrap();
            queue.drain(..).collect()
        };

        if signals.is_empty() {
            return;
        }

        // Gateway sync not yet implemented — signals are stored in SQLite
        // and will be synced when POST /eval/signals endpoint is available.
        log::debug!(
            "[eval] Flushed {} eval signals from queue",
            signals.len()
        );
    }

    /// Get the current queue length.
    pub fn queue_len(&self) -> usize {
        self.queue.lock().unwrap().len()
    }
}

/// Submit a satisfaction signal for a message.
///
/// Looks up message metadata from the database, constructs the feature
/// vector, stores it locally, and queues it for Gateway sync.
pub fn submit(
    conn: &rusqlite::Connection,
    eval_state: &EvalState,
    message_id: &str,
    satisfaction: i32,
) -> Result<(), String> {
    if satisfaction != 0 && satisfaction != 1 {
        return Err("satisfaction must be 0 or 1".to_string());
    }

    // Look up message metadata from database
    let metadata_json: Option<String> = conn
        .query_row(
            "SELECT metadata FROM messages WHERE id = ?1",
            rusqlite::params![message_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Message not found: {e}"))?;

    let (task_type, model_id, worker_type) = parse_metadata(&metadata_json);

    // Validate task_type against allowlist
    let task_type = if VALID_TASK_TYPES.contains(&task_type.as_str()) {
        task_type
    } else {
        "general_chat".to_string()
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Store in SQLite for persistence across restarts
    conn.execute(
        "INSERT OR REPLACE INTO eval_signals (message_id, task_type, model_id, worker_type, satisfaction, created_at, synced)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
        rusqlite::params![message_id, task_type, model_id, worker_type, satisfaction, now],
    )
    .map_err(|e| format!("Failed to store eval signal: {e}"))?;

    // Queue for batch Gateway sync
    let signal = EvalSignal {
        task_type,
        model_id,
        satisfaction,
        worker_type,
        delegation_type: Some("in_loop".to_string()),
        had_tool_errors: false,
        duration_ms: None,
        created_at: now,
    };

    eval_state.enqueue(signal);

    Ok(())
}

/// Parse metadata JSON to extract feature vector fields.
fn parse_metadata(json: &Option<String>) -> (String, Option<String>, Option<String>) {
    let Some(json_str) = json else {
        return ("general_chat".to_string(), None, None);
    };

    let Ok(meta) = serde_json::from_str::<serde_json::Value>(json_str) else {
        return ("general_chat".to_string(), None, None);
    };

    let task_type = meta
        .get("task_type")
        .and_then(|v| v.as_str())
        .unwrap_or("general_chat")
        .to_string();

    let model_id = meta
        .get("model_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let worker_type = meta
        .get("worker_type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    (task_type, model_id, worker_type)
}

/// Validate that a task_type is in the allowlist.
pub fn is_valid_task_type(task_type: &str) -> bool {
    VALID_TASK_TYPES.contains(&task_type)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::setup_schema;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    fn insert_message(conn: &Connection, id: &str, metadata: Option<&str>) {
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Test', 1000)",
            [],
        )
        .ok();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, metadata)
             VALUES (?1, 'c1', 'assistant', 'test response', 1000, ?2)",
            rusqlite::params![id, metadata],
        )
        .unwrap();
    }

    #[test]
    fn submit_stores_eval_signal() {
        let conn = setup_test_db();
        let state = EvalState::new();
        insert_message(
            &conn,
            "msg1",
            Some(r#"{"v":1,"task_type":"code_generation","model_id":"claude-opus-4-6","worker_type":"chat_model"}"#),
        );

        submit(&conn, &state, "msg1", 1).unwrap();

        let task_type: String = conn
            .query_row(
                "SELECT task_type FROM eval_signals WHERE message_id = 'msg1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_type, "code_generation");
        assert_eq!(state.queue_len(), 1);
    }

    #[test]
    fn submit_rejects_invalid_satisfaction() {
        let conn = setup_test_db();
        let state = EvalState::new();
        insert_message(&conn, "msg1", None);

        let result = submit(&conn, &state, "msg1", 5);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must be 0 or 1"));
    }

    #[test]
    fn submit_rejects_nonexistent_message() {
        let conn = setup_test_db();
        let state = EvalState::new();

        let result = submit(&conn, &state, "nonexistent", 1);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Message not found"));
    }

    #[test]
    fn submit_defaults_task_type_for_missing_metadata() {
        let conn = setup_test_db();
        let state = EvalState::new();
        insert_message(&conn, "msg1", None);

        submit(&conn, &state, "msg1", 0).unwrap();

        let task_type: String = conn
            .query_row(
                "SELECT task_type FROM eval_signals WHERE message_id = 'msg1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_type, "general_chat");
    }

    #[test]
    fn submit_validates_task_type_against_allowlist() {
        let conn = setup_test_db();
        let state = EvalState::new();
        insert_message(
            &conn,
            "msg1",
            Some(r#"{"v":1,"task_type":"evil_injection"}"#),
        );

        submit(&conn, &state, "msg1", 1).unwrap();

        let task_type: String = conn
            .query_row(
                "SELECT task_type FROM eval_signals WHERE message_id = 'msg1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(task_type, "general_chat");
    }

    #[test]
    fn feature_vector_contains_no_content() {
        let conn = setup_test_db();
        let state = EvalState::new();
        insert_message(
            &conn,
            "msg1",
            Some(r#"{"v":1,"task_type":"research","model_id":"gpt-4o"}"#),
        );

        submit(&conn, &state, "msg1", 1).unwrap();

        // Verify the queued signal doesn't contain message content
        let queue = state.queue.lock().unwrap();
        let signal = &queue[0];
        let json = serde_json::to_string(signal).unwrap();
        assert!(!json.contains("test response"));
        assert!(!json.contains("content"));
    }

    #[test]
    fn queue_flushes_at_batch_size() {
        let state = EvalState::new();
        for i in 0..BATCH_SIZE {
            state.enqueue(EvalSignal {
                task_type: "general_chat".to_string(),
                model_id: None,
                satisfaction: 1,
                worker_type: None,
                delegation_type: None,
                had_tool_errors: false,
                duration_ms: None,
                created_at: i as i64,
            });
        }

        // Queue should have been flushed when it hit BATCH_SIZE
        assert_eq!(state.queue_len(), 0);
    }

    #[test]
    fn queue_does_not_flush_below_batch_size() {
        let state = EvalState::new();
        for i in 0..(BATCH_SIZE - 1) {
            state.enqueue(EvalSignal {
                task_type: "general_chat".to_string(),
                model_id: None,
                satisfaction: 1,
                worker_type: None,
                delegation_type: None,
                had_tool_errors: false,
                duration_ms: None,
                created_at: i as i64,
            });
        }

        assert_eq!(state.queue_len(), BATCH_SIZE - 1);
    }

    #[test]
    fn valid_task_types_accepted() {
        assert!(is_valid_task_type("code_generation"));
        assert!(is_valid_task_type("research"));
        assert!(is_valid_task_type("general_chat"));
    }

    #[test]
    fn invalid_task_types_rejected() {
        assert!(!is_valid_task_type("evil_injection"));
        assert!(!is_valid_task_type(""));
        assert!(!is_valid_task_type("Code_Generation"));
    }

    #[test]
    fn parse_metadata_handles_missing_fields() {
        let (task, model, worker) = parse_metadata(&Some(r#"{"v":1}"#.to_string()));
        assert_eq!(task, "general_chat");
        assert!(model.is_none());
        assert!(worker.is_none());
    }

    #[test]
    fn parse_metadata_handles_invalid_json() {
        let (task, model, worker) = parse_metadata(&Some("not json".to_string()));
        assert_eq!(task, "general_chat");
        assert!(model.is_none());
        assert!(worker.is_none());
    }
}
