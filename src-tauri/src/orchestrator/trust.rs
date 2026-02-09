// ABOUTME: Trust graduation system tracking satisfaction per (task_type, model_id) pair.
// ABOUTME: Promotes delegation from InLoop to FullHandoff when trust threshold is met.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Minimum number of signals before trust can be evaluated.
const MIN_SIGNALS: u32 = 5;

/// Trust ratio threshold for FullHandoff graduation (80%).
const TRUST_THRESHOLD: f64 = 0.8;

/// Aggregated trust score for a (task_type, model_id) pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustScore {
    pub task_type: String,
    pub model_id: String,
    pub positive: u32,
    pub negative: u32,
}

impl TrustScore {
    pub fn total(&self) -> u32 {
        self.positive + self.negative
    }

    pub fn trust_level(&self) -> f64 {
        if self.total() == 0 {
            return 0.0;
        }
        self.positive as f64 / self.total() as f64
    }

    /// Whether this pair has earned FullHandoff trust.
    pub fn is_trusted(&self) -> bool {
        self.total() >= MIN_SIGNALS && self.trust_level() >= TRUST_THRESHOLD
    }
}

/// Query the trust score for a (task_type, model_id) pair from the local database.
///
/// Computes the score directly from eval_signals table aggregation.
/// Returns None if no signals exist for this pair.
pub fn get_trust_score(
    conn: &Connection,
    task_type: &str,
    model_id: &str,
) -> Option<TrustScore> {
    let result = conn
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN satisfaction = 1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN satisfaction = 0 THEN 1 ELSE 0 END), 0)
             FROM eval_signals
             WHERE task_type = ?1 AND model_id = ?2",
            rusqlite::params![task_type, model_id],
            |row| {
                Ok(TrustScore {
                    task_type: task_type.to_string(),
                    model_id: model_id.to_string(),
                    positive: row.get(0)?,
                    negative: row.get(1)?,
                })
            },
        )
        .ok()?;

    if result.total() == 0 {
        None
    } else {
        Some(result)
    }
}

/// Check if a (task_type, model_id) pair has earned full handoff trust.
pub fn is_trusted(conn: &Connection, task_type: &str, model_id: &str) -> bool {
    get_trust_score(conn, task_type, model_id)
        .map(|score| score.is_trusted())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::setup_schema;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    fn insert_eval_signal(
        conn: &Connection,
        message_id: &str,
        task_type: &str,
        model_id: &str,
        satisfaction: i32,
    ) {
        // Insert a minimal message first (foreign key)
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Test', 1000)",
            [],
        )
        .ok();
        conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, timestamp)
             VALUES (?1, 'c1', 'assistant', 'test', 1000)",
            rusqlite::params![message_id],
        )
        .ok();
        conn.execute(
            "INSERT INTO eval_signals (message_id, task_type, model_id, worker_type, satisfaction, created_at, synced)
             VALUES (?1, ?2, ?3, 'chat_model', ?4, 1000, 0)",
            rusqlite::params![message_id, task_type, model_id, satisfaction],
        )
        .unwrap();
    }

    #[test]
    fn no_signals_returns_none() {
        let conn = setup_test_db();
        let score = get_trust_score(&conn, "code_generation", "claude-opus");
        assert!(score.is_none());
    }

    #[test]
    fn no_signals_not_trusted() {
        let conn = setup_test_db();
        assert!(!is_trusted(&conn, "code_generation", "claude-opus"));
    }

    #[test]
    fn below_minimum_signals_not_trusted() {
        let conn = setup_test_db();
        for i in 0..3 {
            insert_eval_signal(
                &conn,
                &format!("msg{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }

        let score = get_trust_score(&conn, "code_generation", "claude-opus").unwrap();
        assert_eq!(score.positive, 3);
        assert_eq!(score.negative, 0);
        assert_eq!(score.trust_level(), 1.0);
        assert!(!score.is_trusted()); // Below MIN_SIGNALS
    }

    #[test]
    fn five_positive_zero_negative_is_trusted() {
        let conn = setup_test_db();
        for i in 0..5 {
            insert_eval_signal(
                &conn,
                &format!("msg{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }

        let score = get_trust_score(&conn, "code_generation", "claude-opus").unwrap();
        assert_eq!(score.positive, 5);
        assert_eq!(score.negative, 0);
        assert!(score.is_trusted()); // trust = 1.0 >= 0.8, total = 5 >= 5
    }

    #[test]
    fn four_positive_one_negative_is_trusted() {
        let conn = setup_test_db();
        for i in 0..4 {
            insert_eval_signal(
                &conn,
                &format!("msg{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }
        insert_eval_signal(&conn, "msg4", "code_generation", "claude-opus", 0);

        let score = get_trust_score(&conn, "code_generation", "claude-opus").unwrap();
        assert_eq!(score.positive, 4);
        assert_eq!(score.negative, 1);
        assert_eq!(score.trust_level(), 0.8);
        assert!(score.is_trusted()); // trust = 0.8 >= 0.8
    }

    #[test]
    fn three_positive_two_negative_not_trusted() {
        let conn = setup_test_db();
        for i in 0..3 {
            insert_eval_signal(
                &conn,
                &format!("pos{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }
        for i in 0..2 {
            insert_eval_signal(
                &conn,
                &format!("neg{i}"),
                "code_generation",
                "claude-opus",
                0,
            );
        }

        let score = get_trust_score(&conn, "code_generation", "claude-opus").unwrap();
        assert_eq!(score.positive, 3);
        assert_eq!(score.negative, 2);
        assert_eq!(score.trust_level(), 0.6);
        assert!(!score.is_trusted()); // trust = 0.6 < 0.8
    }

    #[test]
    fn scores_are_scoped_to_task_type_and_model() {
        let conn = setup_test_db();
        for i in 0..5 {
            insert_eval_signal(
                &conn,
                &format!("code{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }
        // Different task_type should have no score
        assert!(get_trust_score(&conn, "research", "claude-opus").is_none());
        // Different model should have no score
        assert!(get_trust_score(&conn, "code_generation", "gpt-4o").is_none());
        // Correct pair should be trusted
        assert!(is_trusted(&conn, "code_generation", "claude-opus"));
    }
}
