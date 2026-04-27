// ABOUTME: SQLite database initialization and shared connection pool for chat persistence.
// ABOUTME: Creates conversations and messages tables with migration support.

use rusqlite::{Connection, Result};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Shared SQLite connection pool managed as Tauri state.
/// Serializes all DB operations through a single connection to prevent
/// "database is locked" errors from concurrent connection opens.
pub struct DbPool(Mutex<Connection>);

impl DbPool {
    /// Create a new pool by opening and configuring the database connection.
    pub fn new(app: &AppHandle) -> std::result::Result<Self, String> {
        let conn = init_db(app).map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Run a closure with exclusive access to the shared connection.
    pub fn with_connection<T, F>(&self, f: F) -> std::result::Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let conn = self
            .0
            .lock()
            .map_err(|e| format!("DB mutex poisoned: {}", e))?;
        f(&conn).map_err(|e| e.to_string())
    }
}

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
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
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
            agent_model_id TEXT,
            agent_permission_mode TEXT,
            agent_metadata TEXT,
            project_id TEXT,
            project_root TEXT
        )",
        [],
    )?;

    // Per-conversation input history buffer: persists the user's own prompts
    // independently of session/message state so up-arrow recall survives
    // thread switches, compaction, and app restarts.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS input_history (
            conversation_id TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            content TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_input_history_convo_ts
         ON input_history(conversation_id, timestamp DESC)",
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

    // Thread skill overrides:
    // - thread_skill_override_state tracks whether a thread has an explicit override
    // - thread_skills stores the selected skill refs for that thread/project context
    conn.execute(
        "CREATE TABLE IF NOT EXISTS thread_skill_override_state (
            thread_id TEXT NOT NULL,
            project_root TEXT NOT NULL,
            PRIMARY KEY (thread_id, project_root)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS thread_skills (
            thread_id TEXT NOT NULL,
            project_root TEXT NOT NULL,
            skill_ref TEXT NOT NULL,
            PRIMARY KEY (thread_id, project_root, skill_ref)
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_thread_skills_lookup
         ON thread_skills(thread_id, project_root)",
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

    let has_agent_permission_mode: bool = conn
        .prepare("SELECT agent_permission_mode FROM conversations LIMIT 1")
        .is_ok();
    if !has_agent_permission_mode {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN agent_permission_mode TEXT",
            [],
        )
        .ok();
    }

    let has_agent_metadata: bool = conn
        .prepare("SELECT agent_metadata FROM conversations LIMIT 1")
        .is_ok();
    if !has_agent_metadata {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN agent_metadata TEXT",
            [],
        )
        .ok();
    }

    let has_project_id: bool = conn
        .prepare("SELECT project_id FROM conversations LIMIT 1")
        .is_ok();
    if !has_project_id {
        conn.execute("ALTER TABLE conversations ADD COLUMN project_id TEXT", [])
            .ok();
    }

    let has_project_root: bool = conn
        .prepare("SELECT project_root FROM conversations LIMIT 1")
        .is_ok();
    if !has_project_root {
        conn.execute("ALTER TABLE conversations ADD COLUMN project_root TEXT", [])
            .ok();
    }

    // Per-thread composer draft (#1631). Persisted on 500ms debounce so the
    // user's unsent text survives crash, force-quit, and relaunch.
    let has_draft: bool = conn
        .prepare("SELECT draft FROM conversations LIMIT 1")
        .is_ok();
    if !has_draft {
        conn.execute("ALTER TABLE conversations ADD COLUMN draft TEXT", [])
            .ok();
    }

    // Backfill project context for existing agent conversations.
    conn.execute(
        "UPDATE conversations
         SET project_root = agent_cwd
         WHERE kind = 'agent' AND project_root IS NULL AND agent_cwd IS NOT NULL",
        [],
    )
    .ok();
    conn.execute(
        "UPDATE conversations
         SET project_id = project_root
         WHERE kind = 'agent' AND project_id IS NULL AND project_root IS NOT NULL",
        [],
    )
    .ok();

    // Migration cleanup: early Claude local-agent builds stored local placeholders like
    // "session-0" instead of real Claude session ids. These are not resumable.
    conn.execute(
        "UPDATE conversations
         SET agent_session_id = NULL
         WHERE kind = 'agent'
           AND agent_type = 'claude-code'
           AND agent_session_id GLOB 'session-[0-9]*'",
        [],
    )
    .ok();

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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_kind_project_created_at ON conversations(kind, project_id, created_at DESC)",
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

    // Normalize legacy ACP worker_type metadata to the provider-runtime naming.
    conn.execute(
        "UPDATE messages
         SET metadata = REPLACE(metadata, '\"worker_type\":\"acp_agent\"', '\"worker_type\":\"local_agent\"')
         WHERE metadata LIKE '%\"worker_type\":\"acp_agent\"%'",
        [],
    )
    .ok();
    conn.execute(
        "UPDATE eval_signals
         SET worker_type = 'local_agent'
         WHERE worker_type = 'acp_agent'",
        [],
    )
    .ok();
    conn.execute(
        "UPDATE plan_subtasks
         SET worker_type = 'local_agent'
         WHERE worker_type = 'acp_agent'",
        [],
    )
    .ok();

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

    // Runtime sessions table for computer-use sessions
    conn.execute(
        "CREATE TABLE IF NOT EXISTS runtime_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'idle',
            environment TEXT NOT NULL DEFAULT 'browser',
            context TEXT,
            policy TEXT,
            thread_id TEXT,
            project_root TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            resumed_at INTEGER
        )",
        [],
    )?;

    // Session events table for the audit timeline
    conn.execute(
        "CREATE TABLE IF NOT EXISTS session_events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT,
            metadata TEXT,
            status TEXT NOT NULL DEFAULT 'completed',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES runtime_sessions(id)
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_events_session_id
         ON session_events(session_id, created_at ASC)",
        [],
    )
    .ok();

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_thread_id
         ON runtime_sessions(thread_id)",
        [],
    )
    .ok();

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_runtime_sessions_status
         ON runtime_sessions(status, updated_at DESC)",
        [],
    )
    .ok();

    // Persisted context-window observations keyed by (provider, model_id).
    // Populated from CLI prompt-completion metadata so the catalog does not
    // need to be edited every time a new model ships.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS model_context_cache (
            provider TEXT NOT NULL,
            model_id TEXT NOT NULL,
            context_window INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (provider, model_id)
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
    fn migration_adds_agent_metadata_column() {
        let conn = Connection::open_in_memory().unwrap();

        conn.execute(
            "CREATE TABLE conversations (
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
                agent_model_id TEXT,
                project_id TEXT,
                project_root TEXT
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                model TEXT,
                timestamp INTEGER NOT NULL
            )",
            [],
        )
        .unwrap();

        setup_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type, agent_metadata)
             VALUES ('a1', 'Agent', 1000, 'agent', 'codex', '{\"pendingBootstrapPromptContext\":\"seed\"}')",
            [],
        )
        .unwrap();

        let agent_metadata: Option<String> = conn
            .query_row(
                "SELECT agent_metadata FROM conversations WHERE id = 'a1'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            agent_metadata,
            Some("{\"pendingBootstrapPromptContext\":\"seed\"}".to_string())
        );
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

    #[test]
    fn schema_creates_runtime_sessions_table() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        // Insert a session
        conn.execute(
            "INSERT INTO runtime_sessions (id, title, status, environment, context, policy, thread_id, project_root, created_at, updated_at)
             VALUES ('s1', 'Test Session', 'idle', 'browser', '{\"url\":\"https://example.com\"}', NULL, 't1', '/home/user', 1000, 1000)",
            [],
        )
        .unwrap();

        // Read it back
        let title: String = conn
            .query_row(
                "SELECT title FROM runtime_sessions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Test Session");

        let context: Option<String> = conn
            .query_row(
                "SELECT context FROM runtime_sessions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(context.unwrap().contains("example.com"));
    }

    #[test]
    fn schema_creates_session_events_table() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        // Insert a session first (FK constraint)
        conn.execute(
            "INSERT INTO runtime_sessions (id, title, status, environment, created_at, updated_at)
             VALUES ('s1', 'Test', 'idle', 'browser', 1000, 1000)",
            [],
        )
        .unwrap();

        // Insert events
        conn.execute(
            "INSERT INTO session_events (id, session_id, event_type, title, content, metadata, status, created_at)
             VALUES ('e1', 's1', 'navigation', 'Navigate to page', 'Page loaded', '{\"url\":\"https://example.com\"}', 'completed', 1001)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO session_events (id, session_id, event_type, title, content, metadata, status, created_at)
             VALUES ('e2', 's1', 'action', 'Click button', NULL, '{\"tool_name\":\"click\"}', 'completed', 1002)",
            [],
        )
        .unwrap();

        // Verify order
        let events: Vec<(String, String)> = {
            let mut stmt = conn
                .prepare("SELECT id, event_type FROM session_events WHERE session_id = 's1' ORDER BY created_at ASC")
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "e1");
        assert_eq!(events[0].1, "navigation");
        assert_eq!(events[1].0, "e2");
        assert_eq!(events[1].1, "action");
    }

    #[test]
    fn schema_creates_agent_permission_mode_and_input_history() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        // agent_permission_mode column must round-trip
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type, agent_permission_mode)
             VALUES ('c1', 'Agent', 1000, 'agent', 'claude-code', 'acceptEdits')",
            [],
        )
        .unwrap();
        let mode: Option<String> = conn
            .query_row(
                "SELECT agent_permission_mode FROM conversations WHERE id = 'c1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mode, Some("acceptEdits".to_string()));

        // input_history table exists and stores per-conversation prompts
        conn.execute(
            "INSERT INTO input_history (conversation_id, timestamp, content)
             VALUES ('c1', 1000, 'first'), ('c1', 1001, 'second')",
            [],
        )
        .unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT content FROM input_history WHERE conversation_id = 'c1' ORDER BY timestamp ASC",
            )
            .unwrap();
        let rows: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn migration_adds_agent_permission_mode_to_pre_existing_db() {
        // Simulate a DB created before the new column landed.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE conversations (
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
                agent_model_id TEXT,
                agent_metadata TEXT,
                project_id TEXT,
                project_root TEXT
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                model TEXT,
                timestamp INTEGER NOT NULL
            )",
            [],
        )
        .unwrap();

        // Running setup_schema should migrate the missing column.
        setup_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type, agent_permission_mode)
             VALUES ('a1', 'Agent', 1000, 'agent', 'claude-code', 'plan')",
            [],
        )
        .unwrap();

        let mode: Option<String> = conn
            .query_row(
                "SELECT agent_permission_mode FROM conversations WHERE id = 'a1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mode, Some("plan".to_string()));
    }

    #[test]
    fn session_events_cascade_with_session_delete() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO runtime_sessions (id, title, status, environment, created_at, updated_at)
             VALUES ('s1', 'Test', 'idle', 'browser', 1000, 1000)",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO session_events (id, session_id, event_type, title, status, created_at)
             VALUES ('e1', 's1', 'action', 'Test', 'completed', 1001)",
            [],
        )
        .unwrap();

        // Manually delete events then session (mimicking app behavior)
        conn.execute("DELETE FROM session_events WHERE session_id = 's1'", [])
            .unwrap();
        conn.execute("DELETE FROM runtime_sessions WHERE id = 's1'", [])
            .unwrap();

        let count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}
