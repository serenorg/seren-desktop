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
            is_archived INTEGER DEFAULT 0
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
}
