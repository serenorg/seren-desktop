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
pub const HISTORY_SYNC_TABLES: &[&str] = &[
    "conversations",
    "messages",
    "message_events",
    "thread_drafts",
    "meetings",
    "transcript_segments",
    "meeting_speaker_assignments",
];

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

/// Durable designation applied to every message persisted for a Privileged
/// Matter conversation. Keeping this at the database persistence chokepoint
/// covers renderer, agent-runtime, and orchestrator writes alike.
pub const PRIVILEGED_MATTER_STAMP: &str =
    "Privileged & Confidential — Prepared in Anticipation of Litigation";

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
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON; \
         PRAGMA wal_autocheckpoint={};",
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

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn enqueue_sync_outbox(
    conn: &Connection,
    table_name: &str,
    row_id: &str,
    op: &str,
) -> Result<()> {
    if !HISTORY_SYNC_TABLES.contains(&table_name) {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "unknown sync table: {table_name}"
        )));
    }
    if op != "upsert" && op != "tombstone" {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "unknown sync operation: {op}"
        )));
    }
    conn.execute(
        "INSERT INTO sync_outbox (table_name, row_id, op, enqueued_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(table_name, row_id) DO UPDATE SET
             op = excluded.op,
             enqueued_at = excluded.enqueued_at",
        rusqlite::params![table_name, row_id, op, now_ms()],
    )?;
    Ok(())
}

pub fn enqueue_sync_tombstone(conn: &Connection, table_name: &str, row_id: &str) -> Result<()> {
    enqueue_sync_outbox(conn, table_name, row_id, "tombstone")
}

pub fn mark_sync_upsert(conn: &Connection, table_name: &str, row_id: &str) -> Result<()> {
    let updated_at = now_ms();
    match table_name {
        "conversations" => {
            conn.execute(
                "UPDATE conversations
                 SET row_version = COALESCE(row_version, 1) + 1,
                     updated_at = ?1,
                     deleted_at = NULL
                 WHERE id = ?2",
                rusqlite::params![updated_at, row_id],
            )?;
        }
        "messages" => {
            conn.execute(
                "UPDATE messages
                 SET row_version = COALESCE(row_version, 1) + 1,
                     updated_at = ?1,
                     deleted_at = NULL
                 WHERE id = ?2",
                rusqlite::params![updated_at, row_id],
            )?;
        }
        "message_events" => {
            conn.execute(
                "UPDATE message_events
                 SET row_version = COALESCE(row_version, 1) + 1,
                     updated_at = ?1,
                     deleted_at = NULL
                 WHERE id = ?2",
                rusqlite::params![updated_at, row_id],
            )?;
        }
        "meetings" => {
            conn.execute(
                "UPDATE meetings
                 SET row_version = COALESCE(row_version, 1) + 1,
                     deleted_at = NULL
                 WHERE id = ?1",
                rusqlite::params![row_id],
            )?;
        }
        "transcript_segments" => {
            conn.execute(
                "UPDATE transcript_segments
                 SET row_version = COALESCE(row_version, 1) + 1,
                     updated_at = ?1,
                     deleted_at = NULL
                 WHERE id = ?2",
                rusqlite::params![updated_at, row_id],
            )?;
        }
        "meeting_speaker_assignments" => {
            conn.execute(
                "UPDATE meeting_speaker_assignments
                 SET row_version = COALESCE(row_version, 1) + 1,
                     updated_at = ?1,
                     deleted_at = NULL
                 WHERE id = ?2",
                rusqlite::params![updated_at, row_id],
            )?;
        }
        "thread_drafts" => {
            conn.execute(
                "UPDATE conversations
                 SET row_version = COALESCE(row_version, 1) + 1,
                     updated_at = ?1,
                     deleted_at = NULL
                 WHERE id = ?2",
                rusqlite::params![updated_at, row_id],
            )?;
        }
        _ => {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "unknown sync table: {table_name}"
            )));
        }
    }
    enqueue_sync_outbox(conn, table_name, row_id, "upsert")
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

fn stamp_privileged_message_metadata(
    conn: &Connection,
    conversation_id: &str,
    metadata: &Option<String>,
) -> Result<Option<String>> {
    let privileged = conn
        .query_row(
            "SELECT privileged, counsel_direction FROM conversations WHERE id = ?1",
            rusqlite::params![conversation_id],
            |row| Ok((row.get::<_, i32>(0)? != 0, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let Some((true, counsel_direction)) = privileged else {
        return Ok(metadata.clone());
    };

    let mut object = match metadata.as_deref() {
        Some(raw) => match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(serde_json::Value::Object(object)) => object,
            Ok(value) => {
                let mut object = serde_json::Map::new();
                object.insert("legacy_metadata".to_string(), value);
                object
            }
            Err(_) => {
                let mut object = serde_json::Map::new();
                object.insert(
                    "legacy_metadata_raw".to_string(),
                    serde_json::Value::String(raw.to_string()),
                );
                object
            }
        },
        None => serde_json::Map::new(),
    };
    object.insert(
        "privileged_matter_stamp".to_string(),
        serde_json::Value::String(PRIVILEGED_MATTER_STAMP.to_string()),
    );
    if let Some(direction) = counsel_direction
        .as_deref()
        .map(str::trim)
        .filter(|direction| !direction.is_empty())
    {
        object.insert(
            "counsel_direction".to_string(),
            serde_json::Value::String(direction.to_string()),
        );
    }
    serde_json::to_string(&serde_json::Value::Object(object))
        .map(Some)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

pub fn save_message_record(conn: &Connection, message: &PersistedMessage) -> Result<()> {
    let metadata =
        stamp_privileged_message_metadata(conn, &message.conversation_id, &message.metadata)?;
    if let Err(err) = conn.execute(
        "INSERT INTO messages (
            id, conversation_id, role, content, model, timestamp, metadata,
            provider, row_version, updated_at, deleted_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?6, NULL)
         ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            role = excluded.role,
            content = excluded.content,
            model = excluded.model,
            timestamp = excluded.timestamp,
            metadata = excluded.metadata,
            provider = excluded.provider,
            row_version = COALESCE(messages.row_version, 1) + 1,
            updated_at = excluded.updated_at,
            deleted_at = NULL",
        rusqlite::params![
            message.id,
            message.conversation_id,
            message.role,
            message.content,
            message.model,
            message.timestamp,
            metadata.as_deref(),
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

    enqueue_sync_outbox(conn, "messages", &message.id, "upsert")?;

    let event_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO message_events (
            id, conversation_id, message_id, event_type, status, metadata,
            created_at, row_version, updated_at, deleted_at
         )
         VALUES (?1, ?2, ?3, 'message_persisted', 'completed', ?4, ?5, 1, ?5, NULL)",
        rusqlite::params![
            event_id,
            message.conversation_id,
            message.id,
            metadata.as_deref(),
            message.timestamp
        ],
    )?;
    enqueue_sync_outbox(conn, "message_events", &event_id, "upsert")?;

    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
        rusqlite::params![message.conversation_id],
        |row| row.get(0),
    )?;
    if count > MAX_MESSAGES_PER_CONVERSATION {
        let mut stmt = conn.prepare(
            "SELECT id FROM messages WHERE conversation_id = ?1 AND id NOT IN (
                SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY timestamp DESC LIMIT ?2
            )",
        )?;
        let stale_ids = stmt
            .query_map(
                rusqlite::params![message.conversation_id, MAX_MESSAGES_PER_CONVERSATION],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>>>()?;
        drop(stmt);
        let mut event_stmt = conn.prepare("SELECT id FROM message_events WHERE message_id = ?1")?;
        for stale_id in &stale_ids {
            let event_ids = event_stmt
                .query_map(rusqlite::params![stale_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>>>()?;
            for event_id in event_ids {
                enqueue_sync_tombstone(conn, "message_events", &event_id)?;
            }
            enqueue_sync_tombstone(conn, "messages", stale_id)?;
        }
        drop(event_stmt);
        conn.execute(
            "DELETE FROM message_events WHERE message_id IN (
                SELECT id FROM messages WHERE conversation_id = ?1 AND id NOT IN (
                    SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY timestamp DESC LIMIT ?2
                )
            )",
            rusqlite::params![message.conversation_id, MAX_MESSAGES_PER_CONVERSATION],
        )?;
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND id NOT IN (
                SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY timestamp DESC LIMIT ?2
            )",
            rusqlite::params![message.conversation_id, MAX_MESSAGES_PER_CONVERSATION],
        )?;
    }

    Ok(())
}

/// Stamp messages that were already present when a conversation is switched
/// into Privileged Matter Mode. Future writes flow through `save_message_record`;
/// this closes the retroactive gap without duplicating stamp logic in callers.
pub fn stamp_existing_privileged_messages(
    conn: &Connection,
    conversation_id: &str,
) -> Result<()> {
    let messages = {
        let mut stmt = conn.prepare(
            "SELECT id, metadata FROM messages
             WHERE conversation_id = ?1 AND deleted_at IS NULL",
        )?;
        stmt.query_map(rusqlite::params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<Result<Vec<_>>>()?
    };

    for (message_id, previous_metadata) in messages {
        let metadata =
            stamp_privileged_message_metadata(conn, conversation_id, &previous_metadata)?;
        if metadata != previous_metadata {
            conn.execute(
                "UPDATE messages SET metadata = ?1 WHERE id = ?2",
                rusqlite::params![metadata, message_id],
            )?;
            mark_sync_upsert(conn, "messages", &message_id)?;
        }
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

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("SELECT {column} FROM {table} LIMIT 1"))
        .is_ok()
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<()> {
    if !column_exists(conn, table, column) {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn setup_history_sync_schema(conn: &Connection) -> Result<()> {
    add_column_if_missing(
        conn,
        "conversations",
        "row_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(conn, "conversations", "deleted_at", "INTEGER")?;
    add_column_if_missing(conn, "conversations", "synced_at", "INTEGER")?;
    add_column_if_missing(conn, "conversations", "updated_at", "INTEGER")?;
    conn.execute(
        "UPDATE conversations
         SET updated_at = created_at
         WHERE updated_at IS NULL OR updated_at = 0",
        [],
    )
    .ok();

    add_column_if_missing(
        conn,
        "messages",
        "row_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(conn, "messages", "deleted_at", "INTEGER")?;
    add_column_if_missing(conn, "messages", "synced_at", "INTEGER")?;
    add_column_if_missing(conn, "messages", "updated_at", "INTEGER")?;
    conn.execute(
        "UPDATE messages
         SET updated_at = timestamp
         WHERE updated_at IS NULL OR updated_at = 0",
        [],
    )
    .ok();

    add_column_if_missing(
        conn,
        "message_events",
        "row_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(conn, "message_events", "deleted_at", "INTEGER")?;
    add_column_if_missing(conn, "message_events", "synced_at", "INTEGER")?;
    add_column_if_missing(conn, "message_events", "updated_at", "INTEGER")?;
    conn.execute(
        "UPDATE message_events
         SET updated_at = created_at
         WHERE updated_at IS NULL OR updated_at = 0",
        [],
    )
    .ok();

    add_column_if_missing(
        conn,
        "meetings",
        "row_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(conn, "meetings", "deleted_at", "INTEGER")?;
    add_column_if_missing(conn, "meetings", "synced_at", "INTEGER")?;
    add_column_if_missing(conn, "meetings", "updated_at", "INTEGER")?;
    add_column_if_missing(conn, "meetings", "trigger_source", "TEXT")?;
    add_column_if_missing(conn, "meetings", "calendar_event_id", "TEXT")?;
    add_column_if_missing(conn, "meetings", "calendar_provider", "TEXT")?;
    add_column_if_missing(conn, "meetings", "attendees_json", "TEXT")?;
    conn.execute(
        "UPDATE meetings
         SET updated_at = created_at
         WHERE updated_at IS NULL OR updated_at = 0",
        [],
    )
    .ok();

    add_column_if_missing(
        conn,
        "transcript_segments",
        "row_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(conn, "transcript_segments", "deleted_at", "INTEGER")?;
    add_column_if_missing(conn, "transcript_segments", "synced_at", "INTEGER")?;
    add_column_if_missing(conn, "transcript_segments", "updated_at", "INTEGER")?;
    conn.execute(
        "UPDATE transcript_segments
         SET updated_at = created_at
         WHERE updated_at IS NULL OR updated_at = 0",
        [],
    )
    .ok();

    add_column_if_missing(
        conn,
        "meeting_speaker_assignments",
        "row_version",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(conn, "meeting_speaker_assignments", "deleted_at", "INTEGER")?;
    add_column_if_missing(conn, "meeting_speaker_assignments", "synced_at", "INTEGER")?;
    add_column_if_missing(conn, "meeting_speaker_assignments", "updated_at", "INTEGER")?;
    conn.execute(
        "UPDATE meeting_speaker_assignments
         SET updated_at = created_at
         WHERE updated_at IS NULL OR updated_at = 0",
        [],
    )
    .ok();

    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            row_id TEXT NOT NULL,
            op TEXT NOT NULL,
            enqueued_at INTEGER NOT NULL,
            conflict INTEGER NOT NULL DEFAULT 0,
            UNIQUE(table_name, row_id)
        )",
        [],
    )?;
    add_column_if_missing(
        conn,
        "sync_outbox",
        "attempts",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "sync_outbox", "last_error", "TEXT")?;
    add_column_if_missing(conn, "sync_outbox", "last_attempt_at", "INTEGER")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sync_outbox_order
         ON sync_outbox(id ASC)",
        [],
    )
    .ok();
    setup_history_sync_state_schema(conn)?;
    Ok(())
}

fn setup_history_sync_state_schema(conn: &Connection) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS (
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'history_sync_state'
        )",
        [],
        |row| row.get::<_, i64>(0).map(|value| value != 0),
    )?;
    if !exists {
        return create_scoped_history_sync_state(conn);
    }

    if column_exists(conn, "history_sync_state", "sync_scope") {
        return Ok(());
    }

    conn.execute(
        "DROP TABLE IF EXISTS history_sync_state_legacy_migration",
        [],
    )?;
    conn.execute(
        "ALTER TABLE history_sync_state RENAME TO history_sync_state_legacy_migration",
        [],
    )?;
    create_scoped_history_sync_state(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO history_sync_state
            (table_name, sync_scope, last_pulled_version, first_backfill_completed, updated_at)
         SELECT table_name,
                'legacy',
                last_pulled_version,
                first_backfill_completed,
                updated_at
         FROM history_sync_state_legacy_migration",
        [],
    )?;
    conn.execute("DROP TABLE history_sync_state_legacy_migration", [])?;
    Ok(())
}

fn create_scoped_history_sync_state(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS history_sync_state (
            table_name TEXT NOT NULL,
            sync_scope TEXT NOT NULL,
            last_pulled_version INTEGER NOT NULL DEFAULT 0,
            first_backfill_completed INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (table_name, sync_scope)
        )",
        [],
    )?;
    Ok(())
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
            employee_id TEXT,
            privileged INTEGER NOT NULL DEFAULT 0,
            counsel_direction TEXT
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
            failure_reason TEXT,
            capture_diagnostics_json TEXT,
            seren_notes_id TEXT,
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

    conn.execute(
        "CREATE TABLE IF NOT EXISTS meeting_speaker_assignments (
            id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            source TEXT NOT NULL,
            source_key TEXT NOT NULL,
            display_name TEXT NOT NULL,
            attendee_email TEXT,
            scope TEXT NOT NULL,
            segment_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            row_version INTEGER NOT NULL DEFAULT 1,
            deleted_at INTEGER,
            synced_at INTEGER,
            FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
            FOREIGN KEY (segment_id) REFERENCES transcript_segments(id) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_speaker_assignments_meeting
         ON meeting_speaker_assignments(meeting_id)",
        [],
    )?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_assignments_meeting_scope
         ON meeting_speaker_assignments(meeting_id, source, source_key, scope)
         WHERE scope = 'meeting' AND deleted_at IS NULL",
        [],
    )?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_speaker_assignments_segment_scope
         ON meeting_speaker_assignments(meeting_id, segment_id, scope)
         WHERE scope = 'segment' AND deleted_at IS NULL",
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

    // Migration: add persisted failure reasons to meetings for existing DBs.
    let has_failure_reason: bool = conn
        .prepare("SELECT failure_reason FROM meetings LIMIT 1")
        .is_ok();
    if !has_failure_reason {
        conn.execute("ALTER TABLE meetings ADD COLUMN failure_reason TEXT", [])
            .ok();
    }

    // Migration: add capture diagnostics to meetings for existing DBs. This is
    // nullable so historical rows remain valid and only capture lifecycle paths
    // write JSON summaries.
    let has_capture_diagnostics: bool = conn
        .prepare("SELECT capture_diagnostics_json FROM meetings LIMIT 1")
        .is_ok();
    if !has_capture_diagnostics {
        conn.execute(
            "ALTER TABLE meetings ADD COLUMN capture_diagnostics_json TEXT",
            [],
        )
        .ok();
    }

    // Migration: add seren-notes id link to meetings for existing DBs. Nullable
    // so historical rows remain valid; populated only when auto-publish lands.
    let has_seren_notes_id: bool = conn
        .prepare("SELECT seren_notes_id FROM meetings LIMIT 1")
        .is_ok();
    if !has_seren_notes_id {
        conn.execute("ALTER TABLE meetings ADD COLUMN seren_notes_id TEXT", [])
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

    // Privileged Matter Mode is persisted with the conversation so Rust-side
    // index and message-stamping gates do not depend on renderer state. Each
    // probe keeps this migration safe for both fresh and pre-existing DBs.
    let has_privileged: bool = conn
        .prepare("SELECT privileged FROM conversations LIMIT 1")
        .is_ok();
    if !has_privileged {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN privileged INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    let has_counsel_direction: bool = conn
        .prepare("SELECT counsel_direction FROM conversations LIMIT 1")
        .is_ok();
    if !has_counsel_direction {
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN counsel_direction TEXT",
            [],
        )?;
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

    setup_history_sync_schema(conn)?;

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
    setup_happy_provider_session_lifecycle_schema(conn)?;

    Ok(())
}

/// Durable archive fence for provider sessions that may not have a
/// conversation row yet (fresh spawns and predictive standbys).
fn setup_happy_provider_session_lifecycle_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS happy_provider_session_lifecycle (
            provider_session_id TEXT PRIMARY KEY,
            conversation_id TEXT,
            is_archived INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_happy_provider_session_lifecycle_conversation
         ON happy_provider_session_lifecycle(conversation_id);",
    )?;
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
            "INSERT OR IGNORE INTO conversations (id, title, created_at, is_archived, updated_at)
             VALUES (?1, ?2, ?3, 0, ?3)",
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
    fn full_claude_turn_persists_tool_and_diff_blocks_in_order() {
        // #3247: a claude-code turn now persists its whole transcript. Tool and
        // diff blocks ride as role="assistant" rows with a `block_type`
        // discriminator in metadata; they must coexist with prose rows and read
        // back in chronological order through the real get_messages query so the
        // frontend can reconstruct the turn on reload.
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('turn', 'Agent', 1000)",
            [],
        )
        .unwrap();

        let rows: [(&str, &str, &str, Option<&str>, i64); 6] = [
            ("u1", "user", "read the file then edit it", None, 100),
            ("a1", "assistant", "Reading the file.", None, 101),
            (
                "t1",
                "assistant",
                "Read src/main.rs",
                Some(
                    r#"{"v":1,"block_type":"tool","tool_call":{"toolCallId":"tc1","title":"Read src/main.rs","kind":"read","status":"completed"}}"#,
                ),
                102,
            ),
            ("a2", "assistant", "Now editing.", None, 103),
            (
                "d1",
                "assistant",
                "Modified: src/main.rs",
                Some(
                    r#"{"v":1,"block_type":"diff","diff":{"toolCallId":"tc2","path":"src/main.rs","oldText":"a","newText":"b"}}"#,
                ),
                104,
            ),
            ("f1", "assistant", "Done.", None, 105),
        ];
        for (id, role, content, metadata, ts) in rows {
            save_message_record(
                &conn,
                &PersistedMessage {
                    id: id.to_string(),
                    conversation_id: "turn".to_string(),
                    role: role.to_string(),
                    content: content.to_string(),
                    model: None,
                    timestamp: ts,
                    metadata: metadata.map(str::to_string),
                    provider: Some("claude-code".to_string()),
                },
            )
            .unwrap();
        }

        // Mirror the get_messages read: newest-first window, then chronological.
        let mut stmt = conn
            .prepare(
                "SELECT id, metadata FROM messages
                 WHERE conversation_id = 'turn'
                 ORDER BY timestamp DESC LIMIT 1000",
            )
            .unwrap();
        let mut ordered: Vec<(String, Option<String>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        ordered.reverse();

        let ids: Vec<&str> = ordered.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, ["u1", "a1", "t1", "a2", "d1", "f1"]);

        // Block discriminators and payloads survive the write/read round-trip.
        let tool_meta: serde_json::Value =
            serde_json::from_str(ordered[2].1.as_deref().unwrap()).unwrap();
        assert_eq!(tool_meta["block_type"], "tool");
        assert_eq!(tool_meta["tool_call"]["toolCallId"], "tc1");
        let diff_meta: serde_json::Value =
            serde_json::from_str(ordered[4].1.as_deref().unwrap()).unwrap();
        assert_eq!(diff_meta["block_type"], "diff");
        assert_eq!(diff_meta["diff"]["path"], "src/main.rs");

        // Prose rows keep null metadata so they are never misread as blocks.
        assert!(ordered[1].1.is_none());
    }

    #[test]
    fn save_message_record_stamps_all_privileged_persistence_paths() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, privileged, counsel_direction)
             VALUES ('privileged', 'Matter', 1000, 1, 'Counsel-directed review')",
            [],
        )
        .unwrap();

        save_message_record(
            &conn,
            &PersistedMessage {
                id: "m-privileged".to_string(),
                conversation_id: "privileged".to_string(),
                role: "assistant".to_string(),
                content: "work product".to_string(),
                model: None,
                timestamp: 2000,
                metadata: Some(r#"{"origin":"orchestrator"}"#.to_string()),
                provider: None,
            },
        )
        .unwrap();

        for table in ["messages", "message_events"] {
            let metadata: String = conn
                .query_row(
                    &format!("SELECT metadata FROM {table} WHERE conversation_id = 'privileged'"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
            assert_eq!(
                metadata["privileged_matter_stamp"],
                PRIVILEGED_MATTER_STAMP
            );
            assert_eq!(metadata["counsel_direction"], "Counsel-directed review");
            assert_eq!(metadata["origin"], "orchestrator");
        }
    }

    #[test]
    fn marking_a_conversation_privileged_stamps_existing_messages() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at)
             VALUES ('retroactive', 'Matter', 1000)",
            [],
        )
        .unwrap();
        save_message_record(
            &conn,
            &PersistedMessage {
                id: "m-retroactive".to_string(),
                conversation_id: "retroactive".to_string(),
                role: "assistant".to_string(),
                content: "existing work product".to_string(),
                model: None,
                timestamp: 2000,
                metadata: Some(r#"{"origin":"before-toggle"}"#.to_string()),
                provider: None,
            },
        )
        .unwrap();

        conn.execute(
            "UPDATE conversations
             SET privileged = 1, counsel_direction = 'Counsel-directed review'
             WHERE id = 'retroactive'",
            [],
        )
        .unwrap();
        stamp_existing_privileged_messages(&conn, "retroactive").unwrap();

        let metadata: String = conn
            .query_row(
                "SELECT metadata FROM messages WHERE id = 'm-retroactive'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(
            metadata["privileged_matter_stamp"],
            PRIVILEGED_MATTER_STAMP
        );
        assert_eq!(metadata["counsel_direction"], "Counsel-directed review");
        assert_eq!(metadata["origin"], "before-toggle");
    }

    #[test]
    fn save_message_record_prune_tombstones_message_events() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Chat', 1000)",
            [],
        )
        .unwrap();

        for idx in 0..=MAX_MESSAGES_PER_CONVERSATION {
            save_message_record(
                &conn,
                &PersistedMessage {
                    id: format!("m{idx}"),
                    conversation_id: "c1".to_string(),
                    role: "user".to_string(),
                    content: format!("message {idx}"),
                    model: None,
                    timestamp: 2000 + i64::from(idx),
                    metadata: None,
                    provider: None,
                },
            )
            .unwrap();
        }

        let stale_message_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages WHERE id = 'm0'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let stale_event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM message_events WHERE message_id = 'm0'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let event_tombstones: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_outbox
                 WHERE table_name = 'message_events' AND op = 'tombstone'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(stale_message_count, 0);
        assert_eq!(stale_event_count, 0);
        assert!(event_tombstones >= 1);
    }

    #[test]
    fn mark_sync_upsert_thread_draft_refreshes_snapshot_version() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at, row_version)
             VALUES ('c1', 'Chat', 1000, 1000, 1)",
            [],
        )
        .unwrap();

        mark_sync_upsert(&conn, "thread_drafts", "c1").unwrap();

        let (row_version, updated_at): (i64, i64) = conn
            .query_row(
                "SELECT row_version, updated_at FROM conversations WHERE id = 'c1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let outbox_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_outbox
                 WHERE table_name = 'thread_drafts' AND row_id = 'c1' AND op = 'upsert'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(row_version, 2);
        assert!(updated_at >= 1000);
        assert_eq!(outbox_count, 1);
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
    fn true_deletion_configure_connection_enables_secure_delete() {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();

        let secure_delete: i64 = conn
            .query_row("PRAGMA secure_delete", [], |row| row.get(0))
            .unwrap();
        assert_eq!(secure_delete, 1);
    }

    #[test]
    fn setup_schema_migrates_history_sync_state_to_destination_scopes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE history_sync_state (
                table_name TEXT PRIMARY KEY,
                last_pulled_version INTEGER NOT NULL DEFAULT 0,
                first_backfill_completed INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO history_sync_state
                (table_name, last_pulled_version, first_backfill_completed, updated_at)
             VALUES ('messages', 42, 1, 1000)",
            [],
        )
        .unwrap();

        setup_schema(&conn).unwrap();

        assert!(column_exists(&conn, "history_sync_state", "sync_scope"));
        let migrated: (String, String, i64, i64) = conn
            .query_row(
                "SELECT table_name, sync_scope, last_pulled_version, first_backfill_completed
                 FROM history_sync_state
                 WHERE table_name = 'messages'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            migrated,
            ("messages".to_string(), "legacy".to_string(), 42, 1)
        );
        conn.execute(
            "INSERT INTO history_sync_state
                (table_name, sync_scope, last_pulled_version, first_backfill_completed, updated_at)
             VALUES ('messages', 'new-destination', 0, 0, 2000)",
            [],
        )
        .unwrap();
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
    fn migration_adds_privileged_matter_columns_to_pre_existing_db() {
        // Start from the legacy schema shape before Privileged Matter Mode.
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

        setup_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO conversations (id, title, created_at, privileged, counsel_direction)
             VALUES ('p1', 'Privileged', 1000, 1, 'Counsel-directed review')",
            [],
        )
        .unwrap();
        let values: (i64, Option<String>) = conn
            .query_row(
                "SELECT privileged, counsel_direction FROM conversations WHERE id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(values, (1, Some("Counsel-directed review".to_string())));

        // Re-running setup remains idempotent once both columns exist.
        setup_schema(&conn).unwrap();
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
