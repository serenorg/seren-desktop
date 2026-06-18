// ABOUTME: Bidirectional chat and meeting history sync to the user's SerenDB branch.
// ABOUTME: Keeps local SQLite as the fast path and mirrors durable text rows to Postgres.

use postgres::{Client as PgClient, Row as PgRow};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::auth;
use crate::services::database::{DbPool, HISTORY_SYNC_TABLES, now_ms};

const GATEWAY_BASE_URL: &str = "https://api.serendb.com/publishers/seren-db";
const HISTORY_SYNC_STORE: &str = "history_sync.json";
const CONNECTION_STRING_KEY: &str = "connection_string";
const CONNECTION_STRING_CACHED_AT_KEY: &str = "connection_string_cached_at";
const CONNECTION_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_SYNC_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
const MAX_PUSH_ATTEMPTS: i64 = 5;

const PULL_ORDER: &[&str] = &[
    "conversations",
    "messages",
    "message_events",
    "thread_drafts",
    "meetings",
    "transcript_segments",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySyncConfig {
    pub project_id: String,
    pub branch_id: String,
    pub database_name: String,
}

/// Serializes a history sync run against a remote wipe so the two never
/// interleave on the shared local database and leave the cloud mirror in a
/// stuck or divergent state.
#[derive(Default)]
pub struct HistorySyncLock(std::sync::Arc<tokio::sync::Mutex<()>>);

impl HistorySyncLock {
    fn handle(app: &AppHandle) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        app.state::<HistorySyncLock>().0.clone()
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySyncSummary {
    pub pushed: usize,
    pub pulled: usize,
    pub backfilled: usize,
    pub queued: usize,
    pub conflicts: usize,
}

#[derive(Debug)]
struct OutboxItem {
    id: i64,
    table_name: String,
    row_id: String,
    op: String,
    enqueued_at: i64,
}

#[derive(Debug, Deserialize)]
struct DataEnvelope<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
struct ConnectionStringData {
    connection_string: String,
}

pub fn remote_schema_sql() -> &'static [&'static str] {
    &[
        "CREATE SCHEMA IF NOT EXISTS seren_desktop",
        "CREATE TABLE IF NOT EXISTS seren_desktop.conversations (
            id              text PRIMARY KEY,
            title           text NOT NULL,
            created_at      bigint NOT NULL,
            updated_at      bigint NOT NULL,
            archived_at     bigint,
            deleted_at      bigint,
            payload         jsonb NOT NULL,
            row_version     bigint NOT NULL DEFAULT 1
        )",
        "CREATE TABLE IF NOT EXISTS seren_desktop.messages (
            id              text PRIMARY KEY,
            conversation_id text NOT NULL REFERENCES seren_desktop.conversations(id) ON DELETE CASCADE,
            seq             bigint NOT NULL,
            role            text NOT NULL,
            content         text,
            created_at      bigint NOT NULL,
            updated_at      bigint NOT NULL,
            deleted_at      bigint,
            payload         jsonb NOT NULL,
            row_version     bigint NOT NULL DEFAULT 1,
            UNIQUE (conversation_id, seq)
        )",
        "CREATE TABLE IF NOT EXISTS seren_desktop.message_events (
            id              text PRIMARY KEY,
            conversation_id text NOT NULL REFERENCES seren_desktop.conversations(id) ON DELETE CASCADE,
            message_id      text NOT NULL REFERENCES seren_desktop.messages(id) ON DELETE CASCADE,
            event_type      text NOT NULL,
            status          text NOT NULL,
            payload         jsonb NOT NULL,
            created_at      bigint NOT NULL,
            updated_at      bigint NOT NULL,
            deleted_at      bigint,
            row_version     bigint NOT NULL DEFAULT 1
        )",
        "CREATE TABLE IF NOT EXISTS seren_desktop.thread_drafts (
            conversation_id text PRIMARY KEY REFERENCES seren_desktop.conversations(id) ON DELETE CASCADE,
            text            text NOT NULL,
            updated_at      bigint NOT NULL,
            row_version     bigint NOT NULL DEFAULT 1
        )",
        "CREATE TABLE IF NOT EXISTS seren_desktop.meetings (
            id                      text PRIMARY KEY,
            title                   text NOT NULL,
            source_app              text,
            started_at              bigint NOT NULL,
            ended_at                bigint,
            status                  text NOT NULL,
            template_id             text,
            routed_skill_slug       text,
            agent_conversation_id   text REFERENCES seren_desktop.conversations(id) ON DELETE SET NULL,
            notes_markdown          text,
            notes_struct_json       jsonb,
            archived_at             bigint,
            deleted_at              bigint,
            created_at              bigint NOT NULL,
            updated_at              bigint NOT NULL,
            payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,
            row_version             bigint NOT NULL DEFAULT 1
        )",
        "CREATE TABLE IF NOT EXISTS seren_desktop.transcript_segments (
            id              text PRIMARY KEY,
            meeting_id      text NOT NULL REFERENCES seren_desktop.meetings(id) ON DELETE CASCADE,
            seq             bigint NOT NULL,
            speaker         text NOT NULL,
            text            text NOT NULL,
            start_ms        bigint NOT NULL,
            end_ms          bigint NOT NULL,
            status          text NOT NULL,
            created_at      bigint NOT NULL,
            updated_at      bigint NOT NULL,
            deleted_at      bigint,
            payload         jsonb NOT NULL,
            row_version     bigint NOT NULL DEFAULT 1,
            UNIQUE (meeting_id, seq)
        )",
        "CREATE TABLE IF NOT EXISTS seren_desktop.sync_state (
            table_name      text NOT NULL,
            device_id       text NOT NULL,
            last_pulled_at  bigint NOT NULL,
            PRIMARY KEY (table_name, device_id)
        )",
        "CREATE INDEX IF NOT EXISTS idx_seren_desktop_messages_conversation
            ON seren_desktop.messages(conversation_id, seq)",
        "CREATE INDEX IF NOT EXISTS idx_seren_desktop_message_events_message
            ON seren_desktop.message_events(message_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_seren_desktop_segments_meeting
            ON seren_desktop.transcript_segments(meeting_id, seq)",
    ]
}

pub async fn run_history_sync_once(
    app: AppHandle,
    config: HistorySyncConfig,
) -> Result<HistorySyncSummary, String> {
    let lock = HistorySyncLock::handle(&app);
    let _guard = lock.lock().await;
    let sync_scope = history_sync_scope(&config);
    with_remote_client(&app, &config, move |app, mut client| {
        ensure_remote_schema(&mut client)?;

        let backfilled = with_local_db(&app, |conn| enqueue_initial_backfill(conn, &sync_scope))?;
        let pushed = push_outbox(&app, &mut client)?;
        let pulled = pull_remote(&app, &mut client, &sync_scope)?;
        let (queued, conflicts) = with_local_db(&app, |conn| {
            Ok((
                conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| {
                    row.get::<_, i64>(0)
                })? as usize,
                conn.query_row(
                    "SELECT COUNT(*) FROM sync_outbox WHERE conflict = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )? as usize,
            ))
        })?;

        Ok(HistorySyncSummary {
            pushed,
            pulled,
            backfilled,
            queued,
            conflicts,
        })
    })
    .await
}

pub async fn wipe_remote_history(
    app: AppHandle,
    config: HistorySyncConfig,
    confirmation: String,
) -> Result<(), String> {
    if confirmation != config.database_name {
        return Err(format!(
            "Type {name} to wipe the remote history copy",
            name = config.database_name
        ));
    }
    let lock = HistorySyncLock::handle(&app);
    let _guard = lock.lock().await;
    let sync_scope = history_sync_scope(&config);
    with_remote_client(&app, &config, move |app, mut client| {
        wipe_remote_history_in_order(
            || with_local_db(&app, |conn| reset_local_sync_state(conn, &sync_scope)),
            || {
                client
                    .execute("DROP SCHEMA IF EXISTS seren_desktop CASCADE", &[])
                    .map_err(|err| err.to_string())?;
                ensure_remote_schema(&mut client)
            },
        )
    })
    .await
}

/// Clear local sync bookkeeping after the remote copy is wiped so the next sync
/// performs a fresh full backfill instead of short-circuiting on stale state.
fn reset_local_sync_state(conn: &Connection, sync_scope: &str) -> rusqlite::Result<()> {
    let updated_at = now_ms();
    for table in HISTORY_SYNC_TABLES {
        conn.execute(
            "INSERT INTO history_sync_state
                (table_name, sync_scope, last_pulled_version, first_backfill_completed, updated_at)
             VALUES (?1, ?2, 0, 0, ?3)
             ON CONFLICT(table_name, sync_scope) DO UPDATE SET
                last_pulled_version = 0,
                first_backfill_completed = 0,
                updated_at = excluded.updated_at",
            params![table, sync_scope, updated_at],
        )?;
    }
    for table in HISTORY_SYNC_TABLES {
        // Drafts live on the conversations row, not a table of their own.
        if *table == "thread_drafts" {
            continue;
        }
        conn.execute(&format!("UPDATE {table} SET synced_at = NULL"), [])?;
    }
    conn.execute("DELETE FROM sync_outbox", [])?;
    Ok(())
}

fn ensure_remote_schema(client: &mut PgClient) -> Result<(), String> {
    for statement in remote_schema_sql() {
        client
            .execute(*statement, &[])
            .map_err(|err| format!("failed to apply history sync schema: {err}"))?;
    }
    Ok(())
}

fn wipe_remote_history_in_order(
    mut reset_local_sync_state: impl FnMut() -> Result<(), String>,
    mut wipe_remote_schema: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    reset_local_sync_state()?;
    wipe_remote_schema()
}

/// Resolve the connection string (async) and run a synchronous postgres body on
/// a blocking thread.
///
/// The synchronous `postgres` client drives its own internal tokio runtime via
/// `block_on` on every `connect`/`query`/`execute`. Calling it on a Tauri
/// reactor thread panics with "Cannot start a runtime from within a runtime",
/// so the connect and the entire body that touches the client MUST live on a
/// blocking-pool thread. If the first pass fails with a refreshable auth error,
/// the connection string is refreshed and the body retried once (the body is
/// idempotent and safe to re-run, since connect is its first step).
async fn with_remote_client<T, F>(
    app: &AppHandle,
    config: &HistorySyncConfig,
    body: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(AppHandle, PgClient) -> Result<T, String> + Clone + Send + 'static,
{
    let connection = get_connection_string(app, config, false).await?;
    match run_with_connection(app.clone(), connection, body.clone()).await {
        Err(err) if is_refreshable_postgres_error_text(&err) => {
            let refreshed = get_connection_string(app, config, true).await?;
            run_with_connection(app.clone(), refreshed, body).await
        }
        other => other,
    }
}

async fn run_with_connection<T, F>(app: AppHandle, connection: String, body: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(AppHandle, PgClient) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let client = connect_client(&connection)?;
        body(app, client)
    })
    .await
    .map_err(|err| format!("history sync task failed: {err}"))?
}

fn connect_client(connection_string: &str) -> Result<PgClient, String> {
    let tls = native_tls::TlsConnector::builder()
        .build()
        .map_err(|err| err.to_string())?;
    let tls = postgres_native_tls::MakeTlsConnector::new(tls);
    let mut client = PgClient::connect(connection_string, tls).map_err(|err| err.to_string())?;
    // The idempotent history-sync DDL (CREATE ... IF NOT EXISTS) makes the
    // server emit a NOTICE per already-existing object on every sync tick, and
    // the sync `postgres` crate logs each at INFO (target `postgres::config`).
    // These "already exists, skipping" notices carry no diagnostic value, so
    // suppress them at the protocol source in normal builds — keeping them in
    // debug builds only. WARNING/ERROR still flow through. Best-effort: a
    // failure here must not break the sync. #2500.
    if !cfg!(debug_assertions) {
        if let Err(err) = client.batch_execute("SET client_min_messages = warning") {
            log::debug!("[HistorySync] failed to set client_min_messages: {err}");
        }
    }
    Ok(client)
}

fn is_refreshable_postgres_error_text(err: &str) -> bool {
    let lower = err.to_lowercase();
    err.contains("28P01")
        || err.contains("57P03")
        || lower.contains("password")
        || lower.contains("authentication")
}

fn history_sync_scope(config: &HistorySyncConfig) -> String {
    fn segment(value: &str) -> String {
        format!("{}:{}", value.len(), value)
    }
    format!(
        "v1|{}|{}|{}",
        segment(&config.project_id),
        segment(&config.branch_id),
        segment(&config.database_name)
    )
}

fn scoped_store_key(base: &str, sync_scope: &str) -> String {
    format!("{base}:{sync_scope}")
}

async fn get_connection_string(
    app: &AppHandle,
    config: &HistorySyncConfig,
    force_refresh: bool,
) -> Result<String, String> {
    let sync_scope = history_sync_scope(config);
    let connection_key = scoped_store_key(CONNECTION_STRING_KEY, &sync_scope);
    let cached_at_key = scoped_store_key(CONNECTION_STRING_CACHED_AT_KEY, &sync_scope);
    let store = app
        .store(HISTORY_SYNC_STORE)
        .map_err(|err| format!("failed to open history sync store: {err}"))?;
    let now = now_ms();
    if !force_refresh {
        let cached_at = store
            .get(&cached_at_key)
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        if now.saturating_sub(cached_at) < CONNECTION_TTL_MS {
            if let Some(connection) = store
                .get(&connection_key)
                .and_then(|value| value.as_str().map(str::to_string))
            {
                return Ok(connection);
            }
        }
    }

    let client = reqwest::Client::new();
    let url = format!(
        "{base}/projects/{project}/branches/{branch}/connection-string?pooled=true",
        base = GATEWAY_BASE_URL,
        project = config.project_id,
        branch = config.branch_id
    );
    let response = auth::authenticated_request(app, &client, |client, token| {
        client.get(&url).bearer_auth(token)
    })
    .await?;
    if !response.status().is_success() {
        return Err(format!(
            "connection string request failed: HTTP {}",
            response.status()
        ));
    }
    let envelope: DataEnvelope<ConnectionStringData> = response
        .json()
        .await
        .map_err(|err| format!("connection string response parse failed: {err}"))?;
    store.set(
        &connection_key,
        serde_json::Value::String(envelope.data.connection_string.clone()),
    );
    store.set(&cached_at_key, serde_json::Value::Number(now.into()));
    store
        .save()
        .map_err(|err| format!("failed to save history sync connection cache: {err}"))?;
    Ok(envelope.data.connection_string)
}

fn with_local_db<T>(
    app: &AppHandle,
    task: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let pool = app.state::<DbPool>();
    pool.with_connection(task)
}

fn enqueue_initial_backfill(conn: &Connection, sync_scope: &str) -> rusqlite::Result<usize> {
    let completed: i64 = conn
        .query_row(
            "SELECT MAX(first_backfill_completed)
             FROM history_sync_state
             WHERE sync_scope = ?1",
            params![sync_scope],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten()
        .unwrap_or(0);
    if completed != 0 {
        return Ok(0);
    }

    let mut count = 0usize;
    for table in HISTORY_SYNC_TABLES {
        match *table {
            "thread_drafts" => {
                count += enqueue_rows(
                    conn,
                    table,
                    "SELECT id FROM conversations WHERE draft IS NOT NULL AND draft <> ''",
                )?;
            }
            _ => {
                count += enqueue_rows(conn, table, &format!("SELECT id FROM {table}"))?;
            }
        }
    }
    for table in HISTORY_SYNC_TABLES {
        conn.execute(
            "INSERT INTO history_sync_state
                (table_name, sync_scope, last_pulled_version, first_backfill_completed, updated_at)
             VALUES (?1, ?2, 0, 1, ?3)
             ON CONFLICT(table_name, sync_scope) DO UPDATE SET
                first_backfill_completed = 1,
                updated_at = excluded.updated_at",
            params![table, sync_scope, now_ms()],
        )?;
    }
    Ok(count)
}

fn enqueue_rows(conn: &Connection, table_name: &str, query: &str) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare(query)?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for id in &ids {
        crate::services::database::enqueue_sync_outbox(conn, table_name, id, "upsert")?;
    }
    Ok(ids.len())
}

fn push_outbox(app: &AppHandle, client: &mut PgClient) -> Result<usize, String> {
    let mut pushed = 0usize;
    loop {
        let batch = with_local_db(app, read_outbox_batch)?;
        if batch.is_empty() {
            break;
        }
        let mut left_active_set = 0usize;
        for item in batch {
            match push_outbox_item(app, client, &item) {
                Ok(PushItemOutcome::Pushed) => {
                    clear_outbox_item(app, item.id)?;
                    mark_synced(app, &item.table_name, &item.row_id)?;
                    pushed += 1;
                    left_active_set += 1;
                }
                Ok(PushItemOutcome::Tombstoned) => {
                    clear_outbox_item(app, item.id)?;
                    pushed += 1;
                    left_active_set += 1;
                }
                Ok(PushItemOutcome::Skipped) => {
                    clear_outbox_item(app, item.id)?;
                    left_active_set += 1;
                }
                Err(err) => {
                    let quarantined = record_push_failure(app, item.id, &err)?;
                    if quarantined {
                        left_active_set += 1;
                    }
                }
            }
        }
        if left_active_set == 0 {
            break;
        }
    }
    Ok(pushed)
}

enum PushItemOutcome {
    Pushed,
    Tombstoned,
    Skipped,
}

fn push_outbox_item(
    app: &AppHandle,
    client: &mut PgClient,
    item: &OutboxItem,
) -> Result<PushItemOutcome, String> {
    if item.op == "tombstone" {
        push_tombstone(client, item)?;
        return Ok(PushItemOutcome::Tombstoned);
    }

    let pushed_row = match item.table_name.as_str() {
        "conversations" => {
            if let Some(row) = with_local_db(app, |conn| load_conversation(conn, &item.row_id))? {
                push_conversation(client, row)?;
                true
            } else {
                false
            }
        }
        "messages" => {
            if let Some(row) = with_local_db(app, |conn| load_message(conn, &item.row_id))? {
                push_message(client, row)?;
                true
            } else {
                false
            }
        }
        "message_events" => {
            if let Some(row) = with_local_db(app, |conn| load_message_event(conn, &item.row_id))? {
                push_message_event(client, row)?;
                true
            } else {
                false
            }
        }
        "thread_drafts" => {
            if let Some(row) = with_local_db(app, |conn| load_thread_draft(conn, &item.row_id))? {
                push_thread_draft(client, row)?;
                true
            } else {
                false
            }
        }
        "meetings" => {
            if let Some(row) = with_local_db(app, |conn| load_meeting(conn, &item.row_id))? {
                push_meeting(client, row)?;
                true
            } else {
                false
            }
        }
        "transcript_segments" => {
            if let Some(row) =
                with_local_db(app, |conn| load_transcript_segment(conn, &item.row_id))?
            {
                push_transcript_segment(client, row)?;
                true
            } else {
                false
            }
        }
        _ => false,
    };
    Ok(if pushed_row {
        PushItemOutcome::Pushed
    } else {
        PushItemOutcome::Skipped
    })
}

fn record_push_failure(app: &AppHandle, item_id: i64, error: &str) -> Result<bool, String> {
    with_local_db(app, |conn| {
        let quarantined = record_push_failure_on_conn(conn, item_id, error)?;
        Ok(quarantined)
    })
}

fn record_push_failure_on_conn(
    conn: &Connection,
    item_id: i64,
    error: &str,
) -> rusqlite::Result<bool> {
    let truncated_error: String = error.chars().take(500).collect();
    conn.execute(
        "UPDATE sync_outbox
         SET attempts = attempts + 1,
             last_error = ?1,
             last_attempt_at = ?2,
             conflict = CASE WHEN attempts + 1 >= ?3 THEN 1 ELSE conflict END
         WHERE id = ?4",
        params![truncated_error, now_ms(), MAX_PUSH_ATTEMPTS, item_id],
    )?;
    let conflict: i64 = conn.query_row(
        "SELECT conflict FROM sync_outbox WHERE id = ?1",
        params![item_id],
        |row| row.get(0),
    )?;
    Ok(conflict == 1)
}

fn read_outbox_batch(conn: &Connection) -> rusqlite::Result<Vec<OutboxItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, table_name, row_id, op, enqueued_at
         FROM sync_outbox
         WHERE conflict = 0
         ORDER BY id ASC
         LIMIT 500",
    )?;
    stmt.query_map([], |row| {
        Ok(OutboxItem {
            id: row.get(0)?,
            table_name: row.get(1)?,
            row_id: row.get(2)?,
            op: row.get(3)?,
            enqueued_at: row.get(4)?,
        })
    })?
    .collect()
}

fn clear_outbox_item(app: &AppHandle, id: i64) -> Result<(), String> {
    with_local_db(app, |conn| {
        conn.execute("DELETE FROM sync_outbox WHERE id = ?1", params![id])?;
        Ok(())
    })
}

fn mark_synced(app: &AppHandle, table_name: &str, row_id: &str) -> Result<(), String> {
    with_local_db(app, |conn| {
        let sql = match table_name {
            "conversations" => "UPDATE conversations SET synced_at = ?1 WHERE id = ?2",
            "messages" => "UPDATE messages SET synced_at = ?1 WHERE id = ?2",
            "message_events" => "UPDATE message_events SET synced_at = ?1 WHERE id = ?2",
            "meetings" => "UPDATE meetings SET synced_at = ?1 WHERE id = ?2",
            "transcript_segments" => "UPDATE transcript_segments SET synced_at = ?1 WHERE id = ?2",
            "thread_drafts" => "UPDATE conversations SET synced_at = ?1 WHERE id = ?2",
            _ => return Ok(()),
        };
        conn.execute(sql, params![now_ms(), row_id])?;
        Ok(())
    })
}

fn push_tombstone(client: &mut PgClient, item: &OutboxItem) -> Result<(), String> {
    let deleted_at = item.enqueued_at;
    match item.table_name.as_str() {
        "conversations" => {
            client
                .execute(
                    "UPDATE seren_desktop.conversations
                     SET deleted_at = $2, row_version = row_version + 1
                     WHERE id = $1",
                    &[&item.row_id, &deleted_at],
                )
                .map_err(|err| err.to_string())?;
            client
                .execute(
                    "UPDATE seren_desktop.messages
                     SET deleted_at = $2, row_version = row_version + 1
                     WHERE conversation_id = $1",
                    &[&item.row_id, &deleted_at],
                )
                .map_err(|err| err.to_string())?;
            client
                .execute(
                    "UPDATE seren_desktop.message_events
                     SET deleted_at = $2, row_version = row_version + 1
                     WHERE conversation_id = $1",
                    &[&item.row_id, &deleted_at],
                )
                .map_err(|err| err.to_string())?;
            client
                .execute(
                    "DELETE FROM seren_desktop.thread_drafts WHERE conversation_id = $1",
                    &[&item.row_id],
                )
                .map_err(|err| err.to_string())?;
        }
        "messages" => {
            update_deleted_at(client, "messages", &item.row_id, deleted_at)?;
            client
                .execute(
                    "UPDATE seren_desktop.message_events
                     SET deleted_at = $2, row_version = row_version + 1
                     WHERE message_id = $1",
                    &[&item.row_id, &deleted_at],
                )
                .map_err(|err| err.to_string())?;
        }
        "meetings" => {
            update_deleted_at(client, "meetings", &item.row_id, deleted_at)?;
            client
                .execute(
                    "UPDATE seren_desktop.transcript_segments
                     SET deleted_at = $2, row_version = row_version + 1
                     WHERE meeting_id = $1",
                    &[&item.row_id, &deleted_at],
                )
                .map_err(|err| err.to_string())?;
        }
        "thread_drafts" => {
            client
                .execute(
                    "DELETE FROM seren_desktop.thread_drafts WHERE conversation_id = $1",
                    &[&item.row_id],
                )
                .map_err(|err| err.to_string())?;
        }
        "message_events" | "transcript_segments" => {
            update_deleted_at(client, &item.table_name, &item.row_id, deleted_at)?;
        }
        _ => {}
    }
    Ok(())
}

fn update_deleted_at(
    client: &mut PgClient,
    table_name: &str,
    row_id: &str,
    deleted_at: i64,
) -> Result<(), String> {
    let sql = format!(
        "UPDATE seren_desktop.{table_name}
         SET deleted_at = $2, row_version = row_version + 1
         WHERE id = $1"
    );
    client
        .execute(&sql, &[&row_id, &deleted_at])
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug)]
struct ConversationRow {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    archived_at: Option<i64>,
    deleted_at: Option<i64>,
    payload: Value,
    row_version: i64,
}

fn load_conversation(conn: &Connection, id: &str) -> rusqlite::Result<Option<ConversationRow>> {
    conn.query_row(
        "SELECT id, title, created_at, COALESCE(updated_at, created_at),
                CASE WHEN is_archived = 1 THEN COALESCE(updated_at, created_at) ELSE NULL END,
                deleted_at, row_version, selected_model, selected_provider, project_root,
                is_archived, kind, agent_type, agent_session_id, agent_cwd, agent_model_id,
                agent_permission_mode, agent_metadata, project_id, employee_id, draft
         FROM conversations
         WHERE id = ?1",
        params![id],
        |row| {
            let payload = checked_payload(json!({
                "selected_model": row.get::<_, Option<String>>(7)?,
                "selected_provider": row.get::<_, Option<String>>(8)?,
                "project_root": row.get::<_, Option<String>>(9)?,
                "is_archived": row.get::<_, i64>(10)? != 0,
                "kind": row.get::<_, String>(11)?,
                "agent_type": row.get::<_, Option<String>>(12)?,
                "agent_session_id": row.get::<_, Option<String>>(13)?,
                "agent_cwd": row.get::<_, Option<String>>(14)?,
                "agent_model_id": row.get::<_, Option<String>>(15)?,
                "agent_permission_mode": row.get::<_, Option<String>>(16)?,
                "agent_metadata": parse_json_opt(row.get::<_, Option<String>>(17)?),
                "project_id": row.get::<_, Option<String>>(18)?,
                "employee_id": row.get::<_, Option<String>>(19)?,
                "draft": row.get::<_, Option<String>>(20)?,
            }))
            .map_err(to_sqlite_invalid)?;
            Ok(ConversationRow {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                archived_at: row.get(4)?,
                deleted_at: row.get(5)?,
                row_version: row.get(6)?,
                payload,
            })
        },
    )
    .optional()
}

fn push_conversation(client: &mut PgClient, row: ConversationRow) -> Result<(), String> {
    client
        .execute(
            "INSERT INTO seren_desktop.conversations
            (id, title, created_at, updated_at, archived_at, deleted_at, payload, row_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            updated_at = excluded.updated_at,
            archived_at = excluded.archived_at,
            deleted_at = excluded.deleted_at,
            payload = excluded.payload,
            row_version = excluded.row_version
         WHERE excluded.row_version >= seren_desktop.conversations.row_version",
            &[
                &row.id,
                &row.title,
                &row.created_at,
                &row.updated_at,
                &row.archived_at,
                &row.deleted_at,
                &row.payload,
                &row.row_version,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug)]
struct MessageRow {
    id: String,
    conversation_id: String,
    seq: i64,
    role: String,
    content: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    payload: Value,
    row_version: i64,
}

fn load_message(conn: &Connection, id: &str) -> rusqlite::Result<Option<MessageRow>> {
    conn.query_row(
        "WITH ordered AS (
            SELECT id,
                   ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY timestamp ASC, id ASC) AS seq
            FROM messages
            WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?1)
        )
         SELECT m.id, m.conversation_id, o.seq, m.role, m.content, m.timestamp,
                COALESCE(m.updated_at, m.timestamp), m.deleted_at, m.row_version,
                m.model, m.metadata, m.provider
         FROM messages m
         JOIN ordered o ON o.id = m.id
         WHERE m.id = ?1",
        params![id],
        |row| {
            let payload = checked_payload(json!({
                "model": row.get::<_, Option<String>>(9)?,
                "metadata": parse_json_opt(row.get::<_, Option<String>>(10)?),
                "provider": row.get::<_, Option<String>>(11)?,
            }))
            .map_err(to_sqlite_invalid)?;
            Ok(MessageRow {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                seq: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted_at: row.get(7)?,
                row_version: row.get(8)?,
                payload,
            })
        },
    )
    .optional()
}

fn push_message(client: &mut PgClient, row: MessageRow) -> Result<(), String> {
    client
        .execute(
        "INSERT INTO seren_desktop.messages
            (id, conversation_id, seq, role, content, created_at, updated_at, deleted_at, payload, row_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            seq = excluded.seq,
            role = excluded.role,
            content = excluded.content,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            payload = excluded.payload,
            row_version = excluded.row_version
         WHERE excluded.row_version >= seren_desktop.messages.row_version",
            &[
                &row.id,
                &row.conversation_id,
                &row.seq,
                &row.role,
                &row.content,
                &row.created_at,
                &row.updated_at,
                &row.deleted_at,
                &row.payload,
                &row.row_version,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug)]
struct MessageEventRow {
    id: String,
    conversation_id: String,
    message_id: String,
    event_type: String,
    status: String,
    payload: Value,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    row_version: i64,
}

fn load_message_event(conn: &Connection, id: &str) -> rusqlite::Result<Option<MessageEventRow>> {
    conn.query_row(
        "SELECT id, conversation_id, message_id, event_type, status, metadata,
                created_at, COALESCE(updated_at, created_at), deleted_at, row_version
         FROM message_events
         WHERE id = ?1",
        params![id],
        |row| {
            let payload = checked_payload(json!({
                "metadata": parse_json_opt(row.get::<_, Option<String>>(5)?),
            }))
            .map_err(to_sqlite_invalid)?;
            Ok(MessageEventRow {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                message_id: row.get(2)?,
                event_type: row.get(3)?,
                status: row.get(4)?,
                payload,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                deleted_at: row.get(8)?,
                row_version: row.get(9)?,
            })
        },
    )
    .optional()
}

fn push_message_event(client: &mut PgClient, row: MessageEventRow) -> Result<(), String> {
    client
        .execute(
        "INSERT INTO seren_desktop.message_events
            (id, conversation_id, message_id, event_type, status, payload, created_at, updated_at, deleted_at, row_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            message_id = excluded.message_id,
            event_type = excluded.event_type,
            status = excluded.status,
            payload = excluded.payload,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            row_version = excluded.row_version
         WHERE excluded.row_version >= seren_desktop.message_events.row_version",
            &[
                &row.id,
                &row.conversation_id,
                &row.message_id,
                &row.event_type,
                &row.status,
                &row.payload,
                &row.created_at,
                &row.updated_at,
                &row.deleted_at,
                &row.row_version,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug)]
struct ThreadDraftRow {
    conversation_id: String,
    text: String,
    updated_at: i64,
    row_version: i64,
}

fn load_thread_draft(conn: &Connection, id: &str) -> rusqlite::Result<Option<ThreadDraftRow>> {
    conn.query_row(
        "SELECT id, draft, COALESCE(updated_at, created_at), row_version
         FROM conversations
         WHERE id = ?1 AND draft IS NOT NULL AND draft <> ''",
        params![id],
        |row| {
            Ok(ThreadDraftRow {
                conversation_id: row.get(0)?,
                text: row.get(1)?,
                updated_at: row.get(2)?,
                row_version: row.get(3)?,
            })
        },
    )
    .optional()
}

fn push_thread_draft(client: &mut PgClient, row: ThreadDraftRow) -> Result<(), String> {
    client
        .execute(
            "INSERT INTO seren_desktop.thread_drafts
            (conversation_id, text, updated_at, row_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(conversation_id) DO UPDATE SET
            text = excluded.text,
            updated_at = excluded.updated_at,
            row_version = excluded.row_version
         WHERE excluded.updated_at >= seren_desktop.thread_drafts.updated_at",
            &[
                &row.conversation_id,
                &row.text,
                &row.updated_at,
                &row.row_version,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug)]
struct MeetingRow {
    id: String,
    title: String,
    source_app: Option<String>,
    started_at: i64,
    ended_at: Option<i64>,
    status: String,
    template_id: Option<String>,
    routed_skill_slug: Option<String>,
    agent_conversation_id: Option<String>,
    notes_markdown: Option<String>,
    notes_struct_json: Option<Value>,
    archived_at: Option<i64>,
    deleted_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    payload: Value,
    row_version: i64,
}

/// Extract the optional seren-notes id stashed in a meeting sync payload. The
/// id lives inside the JSONB payload because adding it as a first-class
/// column on the cloud Postgres requires a separate seren-core deploy. Pure
/// helper so the carry-through is unit-testable without a Postgres mock.
pub fn seren_notes_id_from_payload(payload: &Value) -> Option<String> {
    payload.get("seren_notes_id")?.as_str().map(str::to_string)
}

fn load_meeting(conn: &Connection, id: &str) -> rusqlite::Result<Option<MeetingRow>> {
    conn.query_row(
        "SELECT id, title, source_app, started_at, ended_at, status, template_id,
                routed_skill_slug, agent_conversation_id, notes_markdown, notes_struct_json,
                CASE WHEN deleted_at IS NULL THEN NULL ELSE deleted_at END, deleted_at,
                created_at, updated_at, row_version, failure_reason, capture_diagnostics_json,
                seren_notes_id
         FROM meetings
         WHERE id = ?1",
        params![id],
        |row| {
            let notes_struct_json = parse_json_opt(row.get::<_, Option<String>>(10)?);
            let payload = checked_payload(json!({
                "failure_reason": row.get::<_, Option<String>>(16)?,
                "capture_diagnostics_json": parse_json_opt(row.get::<_, Option<String>>(17)?),
                "seren_notes_id": row.get::<_, Option<String>>(18)?,
            }))
            .map_err(to_sqlite_invalid)?;
            Ok(MeetingRow {
                id: row.get(0)?,
                title: row.get(1)?,
                source_app: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                status: row.get(5)?,
                template_id: row.get(6)?,
                routed_skill_slug: row.get(7)?,
                agent_conversation_id: row.get(8)?,
                notes_markdown: row.get(9)?,
                notes_struct_json: if notes_struct_json.is_null() {
                    None
                } else {
                    Some(notes_struct_json)
                },
                archived_at: row.get(11)?,
                deleted_at: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
                row_version: row.get(15)?,
                payload,
            })
        },
    )
    .optional()
}

fn push_meeting(client: &mut PgClient, row: MeetingRow) -> Result<(), String> {
    client
        .execute(
            "INSERT INTO seren_desktop.meetings
            (id, title, source_app, started_at, ended_at, status, template_id,
             routed_skill_slug, agent_conversation_id, notes_markdown, notes_struct_json,
             archived_at, deleted_at, created_at, updated_at, payload, row_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            source_app = excluded.source_app,
            ended_at = excluded.ended_at,
            status = excluded.status,
            template_id = excluded.template_id,
            routed_skill_slug = excluded.routed_skill_slug,
            agent_conversation_id = excluded.agent_conversation_id,
            notes_markdown = excluded.notes_markdown,
            notes_struct_json = excluded.notes_struct_json,
            archived_at = excluded.archived_at,
            deleted_at = excluded.deleted_at,
            updated_at = excluded.updated_at,
            payload = excluded.payload,
            row_version = excluded.row_version
         WHERE excluded.row_version >= seren_desktop.meetings.row_version",
            &[
                &row.id,
                &row.title,
                &row.source_app,
                &row.started_at,
                &row.ended_at,
                &row.status,
                &row.template_id,
                &row.routed_skill_slug,
                &row.agent_conversation_id,
                &row.notes_markdown,
                &row.notes_struct_json,
                &row.archived_at,
                &row.deleted_at,
                &row.created_at,
                &row.updated_at,
                &row.payload,
                &row.row_version,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[derive(Debug)]
struct TranscriptSegmentRow {
    id: String,
    meeting_id: String,
    seq: i64,
    speaker: String,
    text: String,
    start_ms: i64,
    end_ms: i64,
    status: String,
    created_at: i64,
    updated_at: i64,
    deleted_at: Option<i64>,
    payload: Value,
    row_version: i64,
}

fn load_transcript_segment(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<TranscriptSegmentRow>> {
    conn.query_row(
        "SELECT id, meeting_id, seq, speaker, text, start_ms, end_ms, status,
                created_at, COALESCE(updated_at, created_at), deleted_at, row_version,
                speaker_label, speaker_source
         FROM transcript_segments
         WHERE id = ?1",
        params![id],
        |row| {
            let payload = checked_payload(json!({
                "speaker_label": row.get::<_, Option<String>>(12)?,
                "speaker_source": row.get::<_, Option<String>>(13)?,
            }))
            .map_err(to_sqlite_invalid)?;
            Ok(TranscriptSegmentRow {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                seq: row.get(2)?,
                speaker: row.get(3)?,
                text: row.get(4)?,
                start_ms: row.get(5)?,
                end_ms: row.get(6)?,
                status: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                deleted_at: row.get(10)?,
                row_version: row.get(11)?,
                payload,
            })
        },
    )
    .optional()
}

fn push_transcript_segment(client: &mut PgClient, row: TranscriptSegmentRow) -> Result<(), String> {
    client
        .execute(
            "INSERT INTO seren_desktop.transcript_segments
            (id, meeting_id, seq, speaker, text, start_ms, end_ms, status,
             created_at, updated_at, deleted_at, payload, row_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT(id) DO UPDATE SET
            meeting_id = excluded.meeting_id,
            seq = excluded.seq,
            speaker = excluded.speaker,
            text = excluded.text,
            start_ms = excluded.start_ms,
            end_ms = excluded.end_ms,
            status = excluded.status,
            updated_at = excluded.updated_at,
            deleted_at = excluded.deleted_at,
            payload = excluded.payload,
            row_version = excluded.row_version
         WHERE excluded.row_version >= seren_desktop.transcript_segments.row_version",
            &[
                &row.id,
                &row.meeting_id,
                &row.seq,
                &row.speaker,
                &row.text,
                &row.start_ms,
                &row.end_ms,
                &row.status,
                &row.created_at,
                &row.updated_at,
                &row.deleted_at,
                &row.payload,
                &row.row_version,
            ],
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn pull_remote(app: &AppHandle, client: &mut PgClient, sync_scope: &str) -> Result<usize, String> {
    let mut pulled = 0usize;
    for table_name in PULL_ORDER {
        let since = local_last_pulled(app, table_name, sync_scope)?;
        let sql = format!(
            "SELECT * FROM seren_desktop.{table_name}
             WHERE row_version > $1
             ORDER BY row_version ASC"
        );
        let rows = client
            .query(&sql, &[&since])
            .map_err(|err| err.to_string())?;
        let mut max_version = since;
        for row in rows {
            let version: i64 = row.try_get("row_version").map_err(|err| err.to_string())?;
            max_version = max_version.max(version);
            apply_remote_row(app, table_name, row)?;
            pulled += 1;
        }
        if max_version > since {
            set_local_last_pulled(app, table_name, sync_scope, max_version)?;
        }
    }
    Ok(pulled)
}

fn local_last_pulled(app: &AppHandle, table_name: &str, sync_scope: &str) -> Result<i64, String> {
    with_local_db(app, |conn| {
        Ok(conn
            .query_row(
                "SELECT last_pulled_version
                 FROM history_sync_state
                 WHERE table_name = ?1 AND sync_scope = ?2",
                params![table_name, sync_scope],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0))
    })
}

fn set_local_last_pulled(
    app: &AppHandle,
    table_name: &str,
    sync_scope: &str,
    version: i64,
) -> Result<(), String> {
    with_local_db(app, |conn| {
        conn.execute(
            "INSERT INTO history_sync_state
                (table_name, sync_scope, last_pulled_version, first_backfill_completed, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4)
             ON CONFLICT(table_name, sync_scope) DO UPDATE SET
                last_pulled_version = excluded.last_pulled_version,
                first_backfill_completed = 1,
                updated_at = excluded.updated_at",
            params![table_name, sync_scope, version, now_ms()],
        )?;
        Ok(())
    })
}

fn apply_remote_row(app: &AppHandle, table_name: &str, row: PgRow) -> Result<(), String> {
    with_local_db(app, |conn| match table_name {
        "conversations" => apply_remote_conversation(conn, row),
        "messages" => apply_remote_message(conn, row),
        "message_events" => apply_remote_message_event(conn, row),
        "thread_drafts" => apply_remote_thread_draft(conn, row),
        "meetings" => apply_remote_meeting(conn, row),
        "transcript_segments" => apply_remote_transcript_segment(conn, row),
        _ => Ok(()),
    })
}

fn apply_remote_conversation(conn: &Connection, row: PgRow) -> rusqlite::Result<()> {
    let id: String = pg_get(&row, "id")?;
    let deleted_at: Option<i64> = pg_get(&row, "deleted_at")?;
    if deleted_at.is_some() {
        delete_conversation_local(conn, &id)?;
        return Ok(());
    }
    let payload: Value = pg_get(&row, "payload")?;
    conn.execute(
        "INSERT INTO conversations (
            id, title, created_at, is_archived, kind, selected_model,
            selected_provider, project_root, agent_type, agent_session_id,
            agent_cwd, agent_model_id, agent_permission_mode, agent_metadata,
            project_id, employee_id, draft, row_version, updated_at, synced_at, deleted_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, NULL)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            is_archived = excluded.is_archived,
            kind = excluded.kind,
            selected_model = excluded.selected_model,
            selected_provider = excluded.selected_provider,
            project_root = excluded.project_root,
            agent_type = excluded.agent_type,
            agent_session_id = excluded.agent_session_id,
            agent_cwd = excluded.agent_cwd,
            agent_model_id = excluded.agent_model_id,
            agent_permission_mode = excluded.agent_permission_mode,
            agent_metadata = excluded.agent_metadata,
            project_id = excluded.project_id,
            employee_id = excluded.employee_id,
            draft = COALESCE(conversations.draft, excluded.draft),
            row_version = excluded.row_version,
            updated_at = excluded.updated_at,
            synced_at = excluded.synced_at,
            deleted_at = NULL
         WHERE COALESCE(conversations.row_version, 0) <= excluded.row_version",
        params![
            id,
            pg_get::<String>(&row, "title")?,
            pg_get::<i64>(&row, "created_at")?,
            value_bool(&payload, "is_archived") as i64,
            value_str(&payload, "kind").unwrap_or_else(|| "chat".to_string()),
            value_opt_str(&payload, "selected_model"),
            value_opt_str(&payload, "selected_provider"),
            value_opt_str(&payload, "project_root"),
            value_opt_str(&payload, "agent_type"),
            value_opt_str(&payload, "agent_session_id"),
            value_opt_str(&payload, "agent_cwd"),
            value_opt_str(&payload, "agent_model_id"),
            value_opt_str(&payload, "agent_permission_mode"),
            value_to_string_opt(payload.get("agent_metadata")),
            value_opt_str(&payload, "project_id"),
            value_opt_str(&payload, "employee_id"),
            value_opt_str(&payload, "draft"),
            pg_get::<i64>(&row, "row_version")?,
            pg_get::<i64>(&row, "updated_at")?,
            now_ms(),
        ],
    )?;
    Ok(())
}

fn apply_remote_message(conn: &Connection, row: PgRow) -> rusqlite::Result<()> {
    let id: String = pg_get(&row, "id")?;
    if pg_get::<Option<i64>>(&row, "deleted_at")?.is_some() {
        conn.execute(
            "DELETE FROM message_events WHERE message_id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
        return Ok(());
    }
    let payload: Value = pg_get(&row, "payload")?;
    conn.execute(
        "INSERT INTO messages (
            id, conversation_id, role, content, model, timestamp, metadata,
            provider, row_version, updated_at, synced_at, deleted_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)
         ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            role = excluded.role,
            content = excluded.content,
            model = excluded.model,
            timestamp = excluded.timestamp,
            metadata = excluded.metadata,
            provider = excluded.provider,
            row_version = excluded.row_version,
            updated_at = excluded.updated_at,
            synced_at = excluded.synced_at,
            deleted_at = NULL
         WHERE COALESCE(messages.row_version, 0) <= excluded.row_version",
        params![
            id,
            pg_get::<String>(&row, "conversation_id")?,
            pg_get::<String>(&row, "role")?,
            pg_get::<Option<String>>(&row, "content")?.unwrap_or_default(),
            value_opt_str(&payload, "model"),
            pg_get::<i64>(&row, "created_at")?,
            value_to_string_opt(payload.get("metadata")),
            value_opt_str(&payload, "provider"),
            pg_get::<i64>(&row, "row_version")?,
            pg_get::<i64>(&row, "updated_at")?,
            now_ms(),
        ],
    )?;
    Ok(())
}

fn apply_remote_message_event(conn: &Connection, row: PgRow) -> rusqlite::Result<()> {
    let id: String = pg_get(&row, "id")?;
    if pg_get::<Option<i64>>(&row, "deleted_at")?.is_some() {
        conn.execute("DELETE FROM message_events WHERE id = ?1", params![id])?;
        return Ok(());
    }
    let payload: Value = pg_get(&row, "payload")?;
    conn.execute(
        "INSERT INTO message_events (
            id, conversation_id, message_id, event_type, status, metadata,
            created_at, row_version, updated_at, synced_at, deleted_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
         ON CONFLICT(id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            message_id = excluded.message_id,
            event_type = excluded.event_type,
            status = excluded.status,
            metadata = excluded.metadata,
            row_version = excluded.row_version,
            updated_at = excluded.updated_at,
            synced_at = excluded.synced_at,
            deleted_at = NULL
         WHERE COALESCE(message_events.row_version, 0) <= excluded.row_version",
        params![
            id,
            pg_get::<String>(&row, "conversation_id")?,
            pg_get::<String>(&row, "message_id")?,
            pg_get::<String>(&row, "event_type")?,
            pg_get::<String>(&row, "status")?,
            value_to_string_opt(payload.get("metadata")),
            pg_get::<i64>(&row, "created_at")?,
            pg_get::<i64>(&row, "row_version")?,
            pg_get::<i64>(&row, "updated_at")?,
            now_ms(),
        ],
    )?;
    Ok(())
}

fn apply_remote_thread_draft(conn: &Connection, row: PgRow) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE conversations
         SET draft = ?1,
             updated_at = ?2,
             row_version = MAX(COALESCE(row_version, 1), ?3),
             synced_at = ?4
         WHERE id = ?5",
        params![
            pg_get::<String>(&row, "text")?,
            pg_get::<i64>(&row, "updated_at")?,
            pg_get::<i64>(&row, "row_version")?,
            now_ms(),
            pg_get::<String>(&row, "conversation_id")?,
        ],
    )?;
    Ok(())
}

fn apply_remote_meeting(conn: &Connection, row: PgRow) -> rusqlite::Result<()> {
    let id: String = pg_get(&row, "id")?;
    if pg_get::<Option<i64>>(&row, "deleted_at")?.is_some() {
        delete_meeting_local(conn, &id)?;
        return Ok(());
    }
    let payload: Value = pg_get(&row, "payload")?;
    conn.execute(
        "INSERT INTO meetings (
            id, title, source_app, started_at, ended_at, status, template_id,
            routed_skill_slug, agent_conversation_id, notes_markdown,
            notes_struct_json, failure_reason, capture_diagnostics_json,
            seren_notes_id, created_at, updated_at, row_version, synced_at, deleted_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, NULL)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            source_app = excluded.source_app,
            ended_at = excluded.ended_at,
            status = excluded.status,
            template_id = excluded.template_id,
            routed_skill_slug = excluded.routed_skill_slug,
            agent_conversation_id = excluded.agent_conversation_id,
            notes_markdown = excluded.notes_markdown,
            notes_struct_json = excluded.notes_struct_json,
            failure_reason = excluded.failure_reason,
            capture_diagnostics_json = excluded.capture_diagnostics_json,
            seren_notes_id = excluded.seren_notes_id,
            updated_at = excluded.updated_at,
            row_version = excluded.row_version,
            synced_at = excluded.synced_at,
            deleted_at = NULL
         WHERE COALESCE(meetings.row_version, 0) <= excluded.row_version",
        params![
            id,
            pg_get::<String>(&row, "title")?,
            pg_get::<Option<String>>(&row, "source_app")?,
            pg_get::<i64>(&row, "started_at")?,
            pg_get::<Option<i64>>(&row, "ended_at")?,
            pg_get::<String>(&row, "status")?,
            pg_get::<Option<String>>(&row, "template_id")?,
            pg_get::<Option<String>>(&row, "routed_skill_slug")?,
            pg_get::<Option<String>>(&row, "agent_conversation_id")?,
            pg_get::<Option<String>>(&row, "notes_markdown")?,
            value_to_string_opt(pg_get::<Option<Value>>(&row, "notes_struct_json")?.as_ref()),
            value_opt_str(&payload, "failure_reason"),
            value_to_string_opt(payload.get("capture_diagnostics_json")),
            seren_notes_id_from_payload(&payload),
            pg_get::<i64>(&row, "created_at")?,
            pg_get::<i64>(&row, "updated_at")?,
            pg_get::<i64>(&row, "row_version")?,
            now_ms(),
        ],
    )?;
    Ok(())
}

fn apply_remote_transcript_segment(conn: &Connection, row: PgRow) -> rusqlite::Result<()> {
    let id: String = pg_get(&row, "id")?;
    if pg_get::<Option<i64>>(&row, "deleted_at")?.is_some() {
        conn.execute("DELETE FROM transcript_segments WHERE id = ?1", params![id])?;
        return Ok(());
    }
    let payload: Value = pg_get(&row, "payload")?;
    conn.execute(
        "INSERT INTO transcript_segments (
            id, meeting_id, seq, speaker, text, start_ms, end_ms, status,
            speaker_label, speaker_source, created_at, row_version, updated_at,
            synced_at, deleted_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL)
         ON CONFLICT(id) DO UPDATE SET
            meeting_id = excluded.meeting_id,
            seq = excluded.seq,
            speaker = excluded.speaker,
            text = excluded.text,
            start_ms = excluded.start_ms,
            end_ms = excluded.end_ms,
            status = excluded.status,
            speaker_label = excluded.speaker_label,
            speaker_source = excluded.speaker_source,
            row_version = excluded.row_version,
            updated_at = excluded.updated_at,
            synced_at = excluded.synced_at,
            deleted_at = NULL
         WHERE COALESCE(transcript_segments.row_version, 0) <= excluded.row_version",
        params![
            id,
            pg_get::<String>(&row, "meeting_id")?,
            pg_get::<i64>(&row, "seq")?,
            pg_get::<String>(&row, "speaker")?,
            pg_get::<String>(&row, "text")?,
            pg_get::<i64>(&row, "start_ms")?,
            pg_get::<i64>(&row, "end_ms")?,
            pg_get::<String>(&row, "status")?,
            value_opt_str(&payload, "speaker_label"),
            value_opt_str(&payload, "speaker_source"),
            pg_get::<i64>(&row, "created_at")?,
            pg_get::<i64>(&row, "row_version")?,
            pg_get::<i64>(&row, "updated_at")?,
            now_ms(),
        ],
    )?;
    Ok(())
}

fn delete_conversation_local(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM message_events WHERE conversation_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    Ok(())
}

fn delete_meeting_local(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM transcript_segments WHERE meeting_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
    Ok(())
}

fn checked_payload(value: Value) -> Result<Value, String> {
    let size = serde_json::to_vec(&value)
        .map_err(|err| err.to_string())?
        .len();
    if size > MAX_SYNC_PAYLOAD_BYTES {
        return Err(format!(
            "history sync payload is too large: {size} bytes exceeds {MAX_SYNC_PAYLOAD_BYTES}"
        ));
    }
    Ok(value)
}

fn parse_json_opt(value: Option<String>) -> Value {
    match value {
        Some(raw) => serde_json::from_str(&raw).unwrap_or(Value::String(raw)),
        None => Value::Null,
    }
}

fn value_opt_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn value_str(value: &Value, key: &str) -> Option<String> {
    value_opt_str(value, key)
}

fn value_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn value_to_string_opt(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Null) | None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

fn to_sqlite_invalid(err: String) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        err,
    )))
}

fn pg_get<T>(row: &PgRow, column: &str) -> rusqlite::Result<T>
where
    T: postgres::types::FromSqlOwned,
{
    row.try_get(column).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::{PersistedMessage, save_message_record, setup_schema};
    use std::cell::RefCell;

    const SCOPE_A: &str = "scope-a";
    const SCOPE_B: &str = "scope-b";

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn connect_client_runs_off_the_reactor_without_runtime_panic() {
        // Regression for the runtime-in-runtime panic: the synchronous
        // `postgres` client calls `block_on` internally, so it must run on a
        // blocking-pool thread, never on a tokio reactor thread. Wrapped in
        // spawn_blocking it returns a normal connection error for an
        // unreachable host instead of panicking — the production sync path
        // routes through the same spawn_blocking in `with_remote_client`.
        let result = tokio::task::spawn_blocking(|| {
            connect_client("postgresql://invalid:invalid@127.0.0.1:1/none")
        })
        .await
        .expect("spawn_blocking task must not panic");
        assert!(
            result.is_err(),
            "expected a connection error from an unreachable host, got Ok"
        );
    }

    #[test]
    fn remote_schema_has_no_audio_binary_columns() {
        let ddl = remote_schema_sql().join("\n").to_lowercase();
        for forbidden in ["bytea", " blob", "raw_audio", "audio_chunk", "pcm_frames"] {
            assert!(
                !ddl.contains(forbidden),
                "history sync schema must not contain {forbidden}"
            );
        }
    }

    #[test]
    fn seren_notes_id_round_trips_through_payload() {
        let payload = json!({
            "failure_reason": null,
            "capture_diagnostics_json": null,
            "seren_notes_id": "276a4660-e16b-4934-97c6-a1ade2426653",
        });
        assert_eq!(
            seren_notes_id_from_payload(&payload).as_deref(),
            Some("276a4660-e16b-4934-97c6-a1ade2426653")
        );
    }

    #[test]
    fn seren_notes_id_absent_payload_returns_none() {
        let payload = json!({
            "failure_reason": "boom",
            "capture_diagnostics_json": null,
        });
        assert!(seren_notes_id_from_payload(&payload).is_none());
    }

    #[test]
    fn seren_notes_id_null_payload_field_returns_none() {
        let payload = json!({ "seren_notes_id": null });
        assert!(seren_notes_id_from_payload(&payload).is_none());
    }

    #[test]
    fn message_snapshot_preserves_tool_event_metadata_json() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind)
             VALUES ('c1', 'Chat', 1000, 'chat')",
            [],
        )
        .unwrap();
        save_message_record(
            &conn,
            &PersistedMessage {
                id: "m1".to_string(),
                conversation_id: "c1".to_string(),
                role: "assistant".to_string(),
                content: "Used a tool".to_string(),
                model: Some("model".to_string()),
                timestamp: 2000,
                metadata: Some(
                    r#"{"tool_call":{"name":"search","args":{"q":"seren"}}}"#.to_string(),
                ),
                provider: Some("seren".to_string()),
            },
        )
        .unwrap();

        let event_id: String = conn
            .query_row(
                "SELECT id FROM message_events WHERE message_id = 'm1' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let event = load_message_event(&conn, &event_id).unwrap().unwrap();
        assert_eq!(
            event.payload["metadata"]["tool_call"]["args"]["q"].as_str(),
            Some("seren")
        );
    }

    #[test]
    fn initial_backfill_enqueues_each_durable_row_once() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, draft)
             VALUES ('c1', 'Chat', 1000, 'chat', 'draft')",
            [],
        )
        .unwrap();
        save_message_record(
            &conn,
            &PersistedMessage {
                id: "m1".to_string(),
                conversation_id: "c1".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                model: None,
                timestamp: 1100,
                metadata: None,
                provider: None,
            },
        )
        .unwrap();

        conn.execute("DELETE FROM sync_outbox", []).unwrap();
        let first = enqueue_initial_backfill(&conn, SCOPE_A).unwrap();
        let second = enqueue_initial_backfill(&conn, SCOPE_A).unwrap();
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
            .unwrap();

        assert!(first >= 3);
        assert_eq!(second, 0);
        assert_eq!(queued, first as i64);
    }

    #[test]
    fn initial_backfill_completion_is_scoped_by_destination() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind)
             VALUES ('c1', 'Chat', 1000, 'chat')",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM sync_outbox", []).unwrap();
        let first_scope_a = enqueue_initial_backfill(&conn, SCOPE_A).unwrap();
        assert!(first_scope_a > 0);
        conn.execute("DELETE FROM sync_outbox", []).unwrap();

        assert_eq!(enqueue_initial_backfill(&conn, SCOPE_A).unwrap(), 0);

        let first_scope_b = enqueue_initial_backfill(&conn, SCOPE_B).unwrap();
        assert_eq!(
            first_scope_b, first_scope_a,
            "a new destination must receive its own initial backfill"
        );
    }

    #[test]
    fn destination_scope_separates_connection_store_keys() {
        let config_a = HistorySyncConfig {
            project_id: "project-a".to_string(),
            branch_id: "branch-a".to_string(),
            database_name: "seren_desktop_history".to_string(),
        };
        let config_b = HistorySyncConfig {
            project_id: "project-b".to_string(),
            branch_id: "branch-a".to_string(),
            database_name: "seren_desktop_history".to_string(),
        };

        let scope_a = history_sync_scope(&config_a);
        let scope_b = history_sync_scope(&config_b);

        assert_ne!(scope_a, scope_b);
        assert_ne!(
            scoped_store_key(CONNECTION_STRING_KEY, &scope_a),
            scoped_store_key(CONNECTION_STRING_KEY, &scope_b)
        );
        assert_ne!(
            scoped_store_key(CONNECTION_STRING_CACHED_AT_KEY, &scope_a),
            scoped_store_key(CONNECTION_STRING_CACHED_AT_KEY, &scope_b)
        );
    }

    fn insert_outbox_row(conn: &Connection, table: &str, row_id: &str) -> i64 {
        conn.execute(
            "INSERT INTO sync_outbox (table_name, row_id, op, enqueued_at)
             VALUES (?1, ?2, 'upsert', 1)",
            params![table, row_id],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn failing_row_quarantines_after_max_attempts() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        let id = insert_outbox_row(&conn, "messages", "poison");

        for attempt in 1..MAX_PUSH_ATTEMPTS {
            let quarantined =
                record_push_failure_on_conn(&conn, id, "remote rejected payload").unwrap();
            assert!(
                !quarantined,
                "row must not quarantine before threshold (attempt {attempt})"
            );
        }
        let quarantined =
            record_push_failure_on_conn(&conn, id, "remote rejected payload").unwrap();
        assert!(
            quarantined,
            "row must quarantine on the {MAX_PUSH_ATTEMPTS}th failure"
        );

        let (attempts, conflict, last_error): (i64, i64, String) = conn
            .query_row(
                "SELECT attempts, conflict, last_error FROM sync_outbox WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(attempts, MAX_PUSH_ATTEMPTS);
        assert_eq!(conflict, 1);
        assert_eq!(last_error, "remote rejected payload");
    }

    #[test]
    fn read_outbox_batch_skips_quarantined_rows() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        let live = insert_outbox_row(&conn, "messages", "live");
        let poisoned = insert_outbox_row(&conn, "messages", "poison");

        for _ in 0..MAX_PUSH_ATTEMPTS {
            record_push_failure_on_conn(&conn, poisoned, "perma-fail").unwrap();
        }

        let batch = read_outbox_batch(&conn).unwrap();
        let ids: Vec<i64> = batch.iter().map(|item| item.id).collect();
        assert_eq!(ids, vec![live], "quarantined row must not appear in batch");
    }

    #[test]
    fn wipe_runs_local_reset_before_destructive_remote_drop() {
        let steps = RefCell::new(Vec::new());

        wipe_remote_history_in_order(
            || {
                steps.borrow_mut().push("local-reset");
                Ok(())
            },
            || {
                steps.borrow_mut().push("remote-drop");
                steps.borrow_mut().push("remote-schema");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            steps.into_inner(),
            vec!["local-reset", "remote-drop", "remote-schema"]
        );
    }

    #[test]
    fn wipe_local_reset_failure_leaves_remote_copy_untouched() {
        let steps = RefCell::new(Vec::new());

        let err = wipe_remote_history_in_order(
            || {
                steps.borrow_mut().push("local-reset");
                Err("database is locked".to_string())
            },
            || {
                steps.borrow_mut().push("remote-drop");
                steps.borrow_mut().push("remote-schema");
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(err, "database is locked");
        assert_eq!(steps.into_inner(), vec!["local-reset"]);
    }

    #[test]
    fn record_push_failure_truncates_long_error_messages() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        let id = insert_outbox_row(&conn, "messages", "long-error");
        let long_error: String = "x".repeat(5_000);

        record_push_failure_on_conn(&conn, id, &long_error).unwrap();

        let stored: String = conn
            .query_row(
                "SELECT last_error FROM sync_outbox WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored.chars().count(), 500);
    }

    #[test]
    fn wipe_resets_local_state_so_backfill_reenqueues() {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind)
             VALUES ('c1', 'Chat', 1000, 'chat')",
            [],
        )
        .unwrap();
        save_message_record(
            &conn,
            &PersistedMessage {
                id: "m1".to_string(),
                conversation_id: "c1".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                model: None,
                timestamp: 1100,
                metadata: None,
                provider: None,
            },
        )
        .unwrap();

        // First sync: backfill everything, then simulate a successful push that
        // drains the outbox and stamps rows as synced.
        let first = enqueue_initial_backfill(&conn, SCOPE_A).unwrap();
        assert!(first >= 2);
        conn.execute("DELETE FROM sync_outbox", []).unwrap();
        conn.execute("UPDATE conversations SET synced_at = 123", [])
            .unwrap();
        conn.execute("UPDATE messages SET synced_at = 123", [])
            .unwrap();

        // Without a reset, a re-sync short-circuits and uploads nothing — the bug.
        assert_eq!(enqueue_initial_backfill(&conn, SCOPE_A).unwrap(), 0);

        // Wiping the remote must reset local state so the next sync re-uploads.
        reset_local_sync_state(&conn, SCOPE_A).unwrap();

        let completed: i64 = conn
            .query_row(
                "SELECT MAX(first_backfill_completed)
                 FROM history_sync_state
                 WHERE sync_scope = ?1",
                params![SCOPE_A],
                |row| row.get::<_, Option<i64>>(0),
            )
            .unwrap()
            .unwrap_or(0);
        assert_eq!(completed, 0, "backfill flag must be cleared");

        let still_synced: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE synced_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_synced, 0, "synced_at must be cleared");

        let outbox: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| row.get(0))
            .unwrap();
        assert_eq!(outbox, 0, "stale outbox rows must be cleared");

        // The next backfill re-enqueues the full history.
        assert_eq!(enqueue_initial_backfill(&conn, SCOPE_A).unwrap(), first);
    }
}
