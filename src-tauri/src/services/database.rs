// ABOUTME: SQLite database initialization and shared connection pool for chat persistence.
// ABOUTME: Creates conversations and messages tables with migration support.

use rusqlite::{Connection, OptionalExtension, Result};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const MAX_MESSAGES_PER_CONVERSATION: i32 = 1000;

#[derive(Debug, Clone, PartialEq)]
pub struct PersistedMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub timestamp: i64,
    pub metadata: Option<String>,
    pub provider: Option<String>,
}

pub const WAL_AUTOCHECKPOINT_PAGES: u32 = 200;
const WAL_CHECKPOINT_INTERVAL_SECS: u64 = 10;

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

    #[cfg(test)]
    pub fn from_connection_for_test(conn: Connection) -> Self {
        Self(Mutex::new(conn))
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

    pub fn checkpoint_wal(&self, mode: WalCheckpointMode) -> std::result::Result<(), String> {
        self.with_connection(|conn| checkpoint_wal(conn, mode))
    }
}

#[derive(Debug, Clone, Copy)]
pub enum WalCheckpointMode {
    Restart,
    Truncate,
}

impl WalCheckpointMode {
    fn as_sql(self) -> &'static str {
        match self {
            Self::Restart => "RESTART",
            Self::Truncate => "TRUNCATE",
        }
    }
}

#[derive(Default)]
pub struct WalCheckpointTask(Mutex<Option<JoinHandle<()>>>);

impl WalCheckpointTask {
    pub fn replace(&self, handle: JoinHandle<()>) {
        let mut slot = self.0.lock().expect("WAL checkpoint task mutex poisoned");
        if let Some(existing) = slot.take() {
            existing.abort();
        }
        *slot = Some(handle);
    }

    pub fn abort(&self) {
        let mut slot = self.0.lock().expect("WAL checkpoint task mutex poisoned");
        if let Some(existing) = slot.take() {
            existing.abort();
        }
    }
}

pub fn configure_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.execute_batch(&format!(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint={};",
        WAL_AUTOCHECKPOINT_PAGES
    ))?;
    Ok(())
}

pub fn checkpoint_wal(conn: &Connection, mode: WalCheckpointMode) -> Result<()> {
    let sql = format!("PRAGMA wal_checkpoint({})", mode.as_sql());
    conn.query_row(&sql, [], |_row| Ok(()))
}

pub fn checkpoint_managed_db(app: &AppHandle, reason: &str) {
    if let Some(pool) = app.try_state::<DbPool>() {
        match pool.checkpoint_wal(WalCheckpointMode::Truncate) {
            Ok(()) => log::debug!("[Database] WAL checkpoint(TRUNCATE) completed: {}", reason),
            Err(err) => log::warn!(
                "[Database] WAL checkpoint(TRUNCATE) failed during {}: {}",
                reason,
                err
            ),
        }
    }
}

pub fn start_wal_checkpoint_task(app: &AppHandle) {
    let app_handle = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(WAL_CHECKPOINT_INTERVAL_SECS));
        loop {
            interval.tick().await;
            checkpoint_managed_db(&app_handle, "periodic");
        }
    });

    if let Some(task) = app.try_state::<WalCheckpointTask>() {
        task.replace(handle);
    } else {
        handle.abort();
        log::warn!("[Database] WAL checkpoint task state missing; periodic checkpoint disabled");
    }
}

pub fn save_message_record(conn: &Connection, message: &PersistedMessage) -> Result<()> {
    if let Err(err) = conn.execute(
        "INSERT OR REPLACE INTO messages (id, conversation_id, role, content, model, timestamp, metadata, provider)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            message.id,
            message.conversation_id,
            message.role,
            message.content,
            message.model,
            message.timestamp,
            message.metadata,
            message.provider
        ],
    ) {
        log::error!(
            "[Database] Failed to persist message {} for conversation {}: {}",
            message.id,
            message.conversation_id,
            err
        );
        return Err(err);
    }

    log::debug!(
        "[Database] Persisted message {} for conversation {}",
        message.id,
        message.conversation_id
    );

    conn.execute(
        "INSERT INTO message_events (id, conversation_id, message_id, event_type, status, metadata, created_at)
         VALUES (?1, ?2, ?3, 'message_persisted', 'completed', ?4, ?5)",
        rusqlite::params![
            Uuid::new_v4().to_string(),
            message.conversation_id,
            message.id,
            message.metadata,
            message.timestamp
        ],
    )?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
        rusqlite::params![message.conversation_id],
        |row| row.get(0),
    )?;
    if count > MAX_MESSAGES_PER_CONVERSATION {
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND id NOT IN (
                SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY timestamp DESC LIMIT ?2
            )",
            rusqlite::params![message.conversation_id, MAX_MESSAGES_PER_CONVERSATION],
        )?;
    }

    Ok(())
}

pub fn resolve_conversation_provider(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Option<String>> {
    conn.query_row(
        "SELECT COALESCE(
            psr.provider,
            CASE c.kind
                WHEN 'agent' THEN c.agent_type
                ELSE c.selected_provider
            END
         )
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE c.id = ?1",
        rusqlite::params![conversation_id],
        |row| row.get(0),
    )
    .optional()
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
    configure_connection(&conn)?;
    setup_schema(&conn)?;
    checkpoint_wal(&conn, WalCheckpointMode::Restart)?;
    checkpoint_wal(&conn, WalCheckpointMode::Truncate)?;
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
            project_root TEXT,
            employee_id TEXT
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

    conn.execute(
        "CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            source_app TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            status TEXT NOT NULL,
            template_id TEXT,
            routed_skill_slug TEXT,
            agent_conversation_id TEXT,
            notes_markdown TEXT,
            notes_struct_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (agent_conversation_id) REFERENCES conversations(id)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS transcript_segments (
            id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            speaker TEXT NOT NULL,
            text TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            status TEXT NOT NULL,
            speaker_label TEXT,
            speaker_source TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_segments_meeting
         ON transcript_segments(meeting_id, seq)",
        [],
    )?;

    // Migration: add diarization columns to transcript_segments for existing DBs.
    // Both are nullable so the round-trip of older rows is preserved.
    let has_speaker_label: bool = conn
        .prepare("SELECT speaker_label FROM transcript_segments LIMIT 1")
        .is_ok();
    if !has_speaker_label {
        conn.execute(
            "ALTER TABLE transcript_segments ADD COLUMN speaker_label TEXT",
            [],
        )
        .ok();
    }

    let has_speaker_source: bool = conn
        .prepare("SELECT speaker_source FROM transcript_segments LIMIT 1")
        .is_ok();
    if !has_speaker_source {
        conn.execute(
            "ALTER TABLE transcript_segments ADD COLUMN speaker_source TEXT",
            [],
        )
        .ok();
    }

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

    // employee_id links a conversation to a deployed seren-agent (virtual
    // employee). When set, the thread groups under that employee in the
    // sidebar instead of under its projectRoot.
    let has_employee_id: bool = conn
        .prepare("SELECT employee_id FROM conversations LIMIT 1")
        .is_ok();
    if !has_employee_id {
        conn.execute("ALTER TABLE conversations ADD COLUMN employee_id TEXT", [])?;
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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_employee_id ON conversations(employee_id, created_at DESC) WHERE employee_id IS NOT NULL",
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

    conn.execute(
        "CREATE TABLE IF NOT EXISTS message_events (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            metadata TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id),
            FOREIGN KEY (message_id) REFERENCES messages(id)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_message_events_message_id
         ON message_events(message_id, created_at ASC)",
        [],
    )
    .ok();
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_message_events_conversation_id
         ON message_events(conversation_id, created_at ASC)",
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

    // Archived virtual employees: snapshots captured at delete time so the
    // sidebar can still render a parent row for chats whose cloud deployment
    // has been removed. Local-only; the cloud roster will not include the
    // archived id on subsequent refreshes.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS archived_employees (
            id TEXT PRIMARY KEY NOT NULL,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            mode TEXT NOT NULL,
            avatar_seed TEXT NOT NULL,
            archived_at INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_archived_employees_archived_at
         ON archived_employees(archived_at DESC)",
        [],
    )?;

    // Migration: Create default conversation for orphan messages
    migrate_orphan_messages(conn)?;

    setup_provider_runtime_schema(conn)?;

    Ok(())
}

/// Add `messages.provider` and the `provider_session_runtime` table.
///
/// Wrapped in an explicit transaction so a crash mid-migration cannot leave
/// the new column present without its backfill, or the runtime table without
/// its index. Errors propagate up rather than being swallowed by `.ok()`.
fn setup_provider_runtime_schema(conn: &Connection) -> Result<()> {
    let has_provider: bool = conn
        .prepare("SELECT provider FROM messages LIMIT 1")
        .is_ok();
    let has_runtime_table: bool = conn
        .prepare("SELECT 1 FROM provider_session_runtime LIMIT 1")
        .is_ok();

    if has_provider && has_runtime_table {
        return Ok(());
    }

    conn.execute_batch("BEGIN")?;
    let outcome = (|| -> Result<()> {
        if !has_provider {
            conn.execute("ALTER TABLE messages ADD COLUMN provider TEXT", [])?;
            // Backfill best-effort from the owning conversation. Chat threads
            // use the conversation's currently selected provider; agent
            // threads use their agent type. `provider` is producer provenance
            // so user-authored rows stay NULL; only assistant/system/tool
            // rows get a producer attribution.
            conn.execute(
                "UPDATE messages
                 SET provider = (
                     SELECT CASE c.kind
                         WHEN 'agent' THEN c.agent_type
                         ELSE c.selected_provider
                     END
                     FROM conversations c
                     WHERE c.id = messages.conversation_id
                 )
                 WHERE provider IS NULL
                   AND role <> 'user'
                   AND conversation_id IS NOT NULL",
                [],
            )?;
        }

        if !has_runtime_table {
            conn.execute(
                "CREATE TABLE provider_session_runtime (
                    thread_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
                    provider TEXT NOT NULL,
                    model TEXT,
                    native_session_id TEXT,
                    resume_cursor_json TEXT,
                    status TEXT NOT NULL,
                    bootstrap_context TEXT,
                    updated_at INTEGER NOT NULL
                )",
                [],
            )?;
            conn.execute(
                "CREATE INDEX idx_provider_session_runtime_provider
                 ON provider_session_runtime(provider)",
                [],
            )?;
        }
        Ok(())
    })();

    match outcome {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
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
    use rusqlite::params;

    #[test]
    fn save_message_record_is_idempotent_and_audited() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Chat', 1000)",
            [],
        )
        .unwrap();

        let first = PersistedMessage {
            id: "m1".to_string(),
            conversation_id: "c1".to_string(),
            role: "assistant".to_string(),
            content: "draft".to_string(),
            model: Some("model-a".to_string()),
            timestamp: 2000,
            metadata: None,
            provider: Some("seren".to_string()),
        };
        save_message_record(&conn, &first).unwrap();

        let second = PersistedMessage {
            content: "final".to_string(),
            timestamp: 3000,
            ..first
        };
        save_message_record(&conn, &second).unwrap();

        let (count, content, timestamp): (i64, String, i64) = conn
            .query_row(
                "SELECT COUNT(*), content, timestamp FROM messages WHERE id = 'm1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(content, "final");
        assert_eq!(timestamp, 3000);

        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM message_events
                 WHERE conversation_id = 'c1'
                   AND message_id = 'm1'
                   AND event_type = 'message_persisted'
                   AND status = 'completed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 2);
    }

    #[test]
    fn configure_connection_sets_bounded_wal_autocheckpoint() {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();

        let autocheckpoint_pages: i64 = conn
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .unwrap();
        assert_eq!(autocheckpoint_pages, WAL_AUTOCHECKPOINT_PAGES as i64);
    }

    #[test]
    fn pool_checkpoint_truncates_accumulated_wal() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("chat.db");
        let wal_path = dir.path().join("chat.db-wal");
        let conn = Connection::open(&db_path).unwrap();
        configure_connection(&conn).unwrap();
        conn.execute_batch("PRAGMA wal_autocheckpoint=0").unwrap();
        setup_schema(&conn).unwrap();

        for i in 0..500 {
            conn.execute(
                "INSERT INTO conversations (id, title, created_at) VALUES (?1, 'Chat', ?2)",
                params![format!("c{i}"), i],
            )
            .unwrap();
        }

        let before = std::fs::metadata(&wal_path).unwrap().len();
        assert!(before > 0, "test setup should create WAL frames");

        let pool = DbPool::from_connection_for_test(conn);
        pool.checkpoint_wal(WalCheckpointMode::Truncate).unwrap();

        let after = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        assert!(
            after < before,
            "TRUNCATE checkpoint should shrink WAL from {before}, got {after}",
        );
        assert!(
            after < 1024 * 1024,
            "WAL should be bounded after checkpoint"
        );
    }

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
    fn migration_adds_employee_id_column_and_index() {
        let conn = Connection::open_in_memory().unwrap();

        conn.execute(
            "CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                selected_model TEXT,
                selected_provider TEXT,
                is_archived INTEGER DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'chat'
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
            "INSERT INTO conversations (id, title, created_at, employee_id)
             VALUES ('c1', 'Employee Chat', 1000, 'dep_123')",
            [],
        )
        .unwrap();

        let employee_id: Option<String> = conn
            .query_row(
                "SELECT employee_id FROM conversations WHERE id = 'c1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(employee_id, Some("dep_123".to_string()));

        let index_count: i32 = conn
            .query_row(
                "SELECT COUNT(*)
                 FROM sqlite_master
                 WHERE type = 'index'
                   AND name = 'idx_conversations_employee_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1);
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
    fn provenance_migration_adds_provider_column_and_runtime_table() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        // messages.provider exists and accepts writes.
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Test', 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, provider)
             VALUES ('m1', 'c1', 'assistant', 'hi', 1000, 'seren')",
            [],
        )
        .unwrap();

        let provider: Option<String> = conn
            .query_row("SELECT provider FROM messages WHERE id = 'm1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(provider, Some("seren".to_string()));

        // provider_session_runtime table exists and accepts writes.
        conn.execute(
            "INSERT INTO provider_session_runtime
                (thread_id, provider, model, native_session_id, status, updated_at)
             VALUES ('c1', 'claude-code', 'claude-sonnet-4', 'session-abc', 'idle', 1234)",
            [],
        )
        .unwrap();

        let bound_provider: String = conn
            .query_row(
                "SELECT provider FROM provider_session_runtime WHERE thread_id = 'c1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bound_provider, "claude-code");
    }

    #[test]
    fn provenance_backfill_uses_chat_provider_and_agent_type() {
        let conn = Connection::open_in_memory().unwrap();

        // Start from the legacy shape: no provider column, no runtime table.
        conn.execute(
            "CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                selected_model TEXT,
                selected_provider TEXT,
                is_archived INTEGER DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'chat',
                agent_type TEXT
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

        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, selected_provider)
             VALUES ('chat1', 'Chat', 1000, 'chat', 'seren-private')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type)
             VALUES ('agent1', 'Agent', 1000, 'agent', 'codex')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp)
             VALUES ('m_chat', 'chat1', 'assistant', 'hi', 1001),
                    ('m_agent', 'agent1', 'assistant', 'hi', 1002)",
            [],
        )
        .unwrap();

        setup_schema(&conn).unwrap();

        let chat_provider: Option<String> = conn
            .query_row(
                "SELECT provider FROM messages WHERE id = 'm_chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(chat_provider, Some("seren-private".to_string()));

        let agent_provider: Option<String> = conn
            .query_row(
                "SELECT provider FROM messages WHERE id = 'm_agent'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(agent_provider, Some("codex".to_string()));
    }

    #[test]
    fn provenance_backfill_skips_user_authored_rows() {
        // Producer provenance only: backfill should never attribute a user
        // message to a provider, because the user did not produce it.
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
                agent_type TEXT
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
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, selected_provider)
             VALUES ('c1', 'Chat', 1000, 'chat', 'seren')",
            [],
        )
        .unwrap();
        // One user row, one assistant row, one tool row, one system row.
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES
             ('u1', 'c1', 'user', 'hi', 1001),
             ('a1', 'c1', 'assistant', 'hello', 1002),
             ('t1', 'c1', 'tool', 'result', 1003),
             ('s1', 'c1', 'system', 'note', 1004)",
            [],
        )
        .unwrap();

        setup_schema(&conn).unwrap();

        let user_provider: Option<String> = conn
            .query_row("SELECT provider FROM messages WHERE id = 'u1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            user_provider, None,
            "user-authored rows must not receive producer provenance"
        );

        for id in ["a1", "t1", "s1"] {
            let p: Option<String> = conn
                .query_row(
                    "SELECT provider FROM messages WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                p,
                Some("seren".to_string()),
                "row {id} should have backfilled provider"
            );
        }
    }

    #[test]
    fn provenance_backfill_skips_orphan_messages_without_conversation_id() {
        // Orphan rows (no conversation_id) cannot be attributed to a
        // provider — the backfill must leave them NULL rather than blindly
        // running a correlated subquery that returns NULL anyway.
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
                agent_type TEXT
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
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp)
             VALUES ('orphan', NULL, 'assistant', 'hi', 1000)",
            [],
        )
        .unwrap();

        setup_schema(&conn).unwrap();

        // migrate_orphan_messages reassigns the orphan to 'default-conversation',
        // but that synthetic conversation has no selected_provider. The
        // producer is unknown, so the backfill must leave provider NULL.
        let provider: Option<String> = conn
            .query_row(
                "SELECT provider FROM messages WHERE id = 'orphan'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(provider, None);
    }

    #[test]
    fn provenance_migration_handles_pre_conversation_id_message_table() {
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
                agent_type TEXT
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                model TEXT,
                timestamp INTEGER NOT NULL
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, role, content, timestamp)
             VALUES ('legacy', 'assistant', 'hi', 1000)",
            [],
        )
        .unwrap();

        setup_schema(&conn).unwrap();

        let (conversation_id, provider): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT conversation_id, provider FROM messages WHERE id = 'legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(conversation_id, Some("default-conversation".to_string()));
        assert_eq!(provider, None);
    }

    #[test]
    fn provenance_migration_preserves_existing_provider_values() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, selected_provider)
             VALUES ('c1', 'Test', 1000, 'chat', 'seren')",
            [],
        )
        .unwrap();
        // Insert a message that already has a producer value; a second pass
        // through setup_schema must not overwrite it.
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, provider)
             VALUES ('m1', 'c1', 'assistant', 'hi', 1000, 'gemini')",
            [],
        )
        .unwrap();

        setup_schema(&conn).unwrap();

        let provider: Option<String> = conn
            .query_row("SELECT provider FROM messages WHERE id = 'm1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(provider, Some("gemini".to_string()));
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
