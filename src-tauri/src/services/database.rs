// ABOUTME: SQLite database initialization for chat persistence.
// ABOUTME: Creates conversations and messages tables with migration support.

use rusqlite::{Connection, Result};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn get_db_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir")
        .join("chat.db")
}

pub fn init_db(app: &AppHandle) -> Result<Connection> {
    let path = get_db_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(path)?;
    setup_schema(&conn)?;
    Ok(conn)
}

/// Create tables and run migrations on a connection.
/// Extracted from init_db so it can be tested with in-memory SQLite.
pub fn setup_schema(conn: &Connection) -> Result<()> {
    // Create conversations table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            selected_model TEXT,
            selected_provider TEXT,
            is_archived INTEGER DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'chat',
            agent_type TEXT,
            agent_session_id TEXT,
            agent_cwd TEXT,
            agent_model_id TEXT
        )",
        [],
    )?;

    // Create messages table (new schema with conversation_id)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            model TEXT,
            timestamp INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )",
        [],
    )?;

    // Migration: add agent conversation columns if they don't exist (for existing DBs)
    let has_kind: bool = conn
        .prepare("SELECT kind FROM conversations LIMIT 1")
        .is_ok();
    if !has_kind {
        // NOT NULL requires a DEFAULT when added via ALTER TABLE.
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'",
            [],
        )
        .ok();
    }

    let has_agent_type: bool = conn
        .prepare("SELECT agent_type FROM conversations LIMIT 1")
        .is_ok();
    if !has_agent_type {
        conn.execute("ALTER TABLE conversations ADD COLUMN agent_type TEXT", [])
            .ok();
    }

    let has_agent_session_id: bool = conn
        .prepare("SELECT agent_session_id FROM conversations LIMIT 1")
        .is_ok();
    if !has_agent_session_id {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN agent_session_id TEXT",
            [],
        )
        .ok();
    }

    let has_agent_cwd: bool = conn
        .prepare("SELECT agent_cwd FROM conversations LIMIT 1")
        .is_ok();
    if !has_agent_cwd {
        conn.execute("ALTER TABLE conversations ADD COLUMN agent_cwd TEXT", [])
            .ok();
    }

    let has_agent_model_id: bool = conn
        .prepare("SELECT agent_model_id FROM conversations LIMIT 1")
        .is_ok();
    if !has_agent_model_id {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN agent_model_id TEXT",
            [],
        )
        .ok();
    }

    // Helpful indexes for agent history lookups (safe to run repeatedly).
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_kind_created_at ON conversations(kind, created_at DESC)",
        [],
    )
    .ok();
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_agent_session_id ON conversations(agent_session_id)",
        [],
    )
    .ok();

    // Migration: Add conversation_id column if it doesn't exist (for existing DBs)
    let has_conversation_id: bool = conn
        .prepare("SELECT conversation_id FROM messages LIMIT 1")
        .is_ok();

    if !has_conversation_id {
        // Add the column to existing table
        conn.execute("ALTER TABLE messages ADD COLUMN conversation_id TEXT", [])
            .ok(); // Ignore error if column already exists
    }

    // Migration: Add metadata column for orchestrator fields (JSON blob)
    let has_metadata: bool = conn
        .prepare("SELECT metadata FROM messages LIMIT 1")
        .is_ok();

    if !has_metadata {
        conn.execute(
            "ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT NULL",
            [],
        )
        .ok();
    }

    // Create eval_signals table for satisfaction feedback
    conn.execute(
        "CREATE TABLE IF NOT EXISTS eval_signals (
            message_id TEXT PRIMARY KEY,
            task_type TEXT NOT NULL,
            model_id TEXT,
            worker_type TEXT,
            satisfaction INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            synced INTEGER DEFAULT 0,
            FOREIGN KEY (message_id) REFERENCES messages(id)
        )",
        [],
    )?;

    // Migration: Add cost column to eval_signals for Thompson sampling
    let has_cost: bool = conn
        .prepare("SELECT cost FROM eval_signals LIMIT 1")
        .is_ok();

    if !has_cost {
        conn.execute(
            "ALTER TABLE eval_signals ADD COLUMN cost REAL DEFAULT NULL",
            [],
        )
        .ok();
    }

    // Create orchestration_plans table for sub-task decomposition
    conn.execute(
        "CREATE TABLE IF NOT EXISTS orchestration_plans (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            original_prompt TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )",
        [],
    )?;

    // Create plan_subtasks table for individual sub-task tracking
    conn.execute(
        "CREATE TABLE IF NOT EXISTS plan_subtasks (
            id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            task_type TEXT NOT NULL,
            worker_type TEXT NOT NULL,
            model_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            depends_on TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY (plan_id) REFERENCES orchestration_plans(id)
        )",
        [],
    )?;

    // Migration: Create default conversation for orphan messages
    migrate_orphan_messages(conn)?;

    Ok(())
}

/// Migrate messages without a conversation_id to a default conversation
fn migrate_orphan_messages(conn: &Connection) -> Result<()> {
    // Check if there are orphan messages
    let orphan_count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE conversation_id IS NULL",
        [],
        |row| row.get(0),
    )?;

    if orphan_count > 0 {
        // Create a default conversation for existing messages
        let default_id = "default-conversation";
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        conn.execute(
            "INSERT OR IGNORE INTO conversations (id, title, created_at, is_archived)
             VALUES (?1, ?2, ?3, 0)",
            rusqlite::params![default_id, "Previous Chat", now],
        )?;

        // Assign orphan messages to the default conversation
        conn.execute(
            "UPDATE messages SET conversation_id = ?1 WHERE conversation_id IS NULL",
            rusqlite::params![default_id],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_creates_metadata_column() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        // Verify metadata column exists by inserting a row with it
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Test', 1000)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, metadata)
             VALUES ('m1', 'c1', 'user', 'hello', 1000, '{\"v\":1,\"worker_type\":\"chat_model\"}')",
            [],
        )
        .unwrap();

        let metadata: Option<String> = conn
            .query_row("SELECT metadata FROM messages WHERE id = 'm1'", [], |row| {
                row.get(0)
            })
            .unwrap();

        assert!(metadata.is_some());
        assert!(metadata.unwrap().contains("\"v\":1"));
    }

    #[test]
    fn null_metadata_for_pre_orchestrator_messages() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Test', 1000)",
            [],
        )
        .unwrap();

        // Insert message without metadata (simulates pre-migration data)
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp)
             VALUES ('m1', 'c1', 'user', 'hello', 1000)",
            [],
        )
        .unwrap();

        let metadata: Option<String> = conn
            .query_row("SELECT metadata FROM messages WHERE id = 'm1'", [], |row| {
                row.get(0)
            })
            .unwrap();

        assert!(metadata.is_none());
    }

    #[test]
    fn schema_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        // Running setup again should not error
        setup_schema(&conn).unwrap();
    }

    #[test]
    fn orchestration_plan_tables_created() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Test', 1000)",
            [],
        )
        .unwrap();

        // Insert a plan
        conn.execute(
            "INSERT INTO orchestration_plans (id, conversation_id, original_prompt, status, created_at)
             VALUES ('p1', 'c1', '1. Research AI 2. Summarize', 'active', 1000)",
            [],
        )
        .unwrap();

        // Insert subtasks
        conn.execute(
            "INSERT INTO plan_subtasks (id, plan_id, prompt, task_type, worker_type, model_id, status, depends_on, created_at)
             VALUES ('s1', 'p1', 'Research AI', 'research', 'chat_model', 'anthropic/claude-sonnet-4', 'pending', NULL, 1000)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO plan_subtasks (id, plan_id, prompt, task_type, worker_type, model_id, status, depends_on, created_at)
             VALUES ('s2', 'p1', 'Summarize', 'document_generation', 'chat_model', 'anthropic/claude-sonnet-4', 'pending', '[\"s1\"]', 1000)",
            [],
        )
        .unwrap();

        // Verify reads
        let plan_status: String = conn
            .query_row(
                "SELECT status FROM orchestration_plans WHERE id = 'p1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(plan_status, "active");

        let subtask_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM plan_subtasks WHERE plan_id = 'p1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(subtask_count, 2);

        let depends_on: Option<String> = conn
            .query_row(
                "SELECT depends_on FROM plan_subtasks WHERE id = 's2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(depends_on, Some("[\"s1\"]".to_string()));
    }
}
