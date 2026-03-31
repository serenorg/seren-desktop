// ABOUTME: Tauri commands for computer-use runtime session persistence.
// ABOUTME: Handles CRUD for runtime sessions and session events in SQLite.

use crate::services::database::{DbPool, init_db};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ============================================================================
// Types
// ============================================================================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RuntimeSession {
    pub id: String,
    pub title: String,
    pub status: String,
    pub environment: String,
    pub context: Option<String>,
    pub policy: Option<String>,
    pub thread_id: Option<String>,
    pub project_root: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub resumed_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SessionEvent {
    pub id: String,
    pub session_id: String,
    pub event_type: String,
    pub title: String,
    pub content: Option<String>,
    pub metadata: Option<String>,
    pub status: String,
    pub created_at: i64,
}

// ============================================================================
// Session Commands
// ============================================================================

#[tauri::command]
pub async fn create_runtime_session(
    app: AppHandle,
    id: String,
    title: String,
    environment: String,
    thread_id: Option<String>,
    project_root: Option<String>,
    policy: Option<String>,
) -> Result<RuntimeSession, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let session = RuntimeSession {
        id: id.clone(),
        title: title.clone(),
        status: "idle".to_string(),
        environment: environment.clone(),
        context: None,
        policy: policy.clone(),
        thread_id: thread_id.clone(),
        project_root: project_root.clone(),
        created_at: now,
        updated_at: now,
        resumed_at: None,
    };

    run_db(app, move |conn| {
        conn.execute(
            "INSERT INTO runtime_sessions (id, title, status, environment, context, policy, thread_id, project_root, created_at, updated_at, resumed_at)
             VALUES (?1, ?2, 'idle', ?3, NULL, ?4, ?5, ?6, ?7, ?7, NULL)",
            params![id, title, environment, policy, thread_id, project_root, now],
        )?;
        Ok(())
    })
    .await?;

    Ok(session)
}

#[tauri::command]
pub async fn get_runtime_session(
    app: AppHandle,
    id: String,
) -> Result<Option<RuntimeSession>, String> {
    run_db(app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, status, environment, context, policy, thread_id, project_root, created_at, updated_at, resumed_at
             FROM runtime_sessions WHERE id = ?1",
        )?;

        let result = stmt
            .query_row(params![id], |row| {
                Ok(RuntimeSession {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    status: row.get(2)?,
                    environment: row.get(3)?,
                    context: row.get(4)?,
                    policy: row.get(5)?,
                    thread_id: row.get(6)?,
                    project_root: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    resumed_at: row.get(10)?,
                })
            })
            .optional()?;

        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn list_runtime_sessions(
    app: AppHandle,
    limit: Option<i32>,
    thread_id: Option<String>,
) -> Result<Vec<RuntimeSession>, String> {
    run_db(app, move |conn| {
        let limit = limit.unwrap_or(50);

        let rows = if let Some(ref tid) = thread_id {
            let mut stmt = conn.prepare(
                "SELECT id, title, status, environment, context, policy, thread_id, project_root, created_at, updated_at, resumed_at
                 FROM runtime_sessions WHERE thread_id = ?1 ORDER BY updated_at DESC LIMIT ?2",
            )?;
            stmt.query_map(params![tid, limit], |row| {
                Ok(RuntimeSession {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    status: row.get(2)?,
                    environment: row.get(3)?,
                    context: row.get(4)?,
                    policy: row.get(5)?,
                    thread_id: row.get(6)?,
                    project_root: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    resumed_at: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, title, status, environment, context, policy, thread_id, project_root, created_at, updated_at, resumed_at
                 FROM runtime_sessions ORDER BY updated_at DESC LIMIT ?1",
            )?;
            stmt.query_map(params![limit], |row| {
                Ok(RuntimeSession {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    status: row.get(2)?,
                    environment: row.get(3)?,
                    context: row.get(4)?,
                    policy: row.get(5)?,
                    thread_id: row.get(6)?,
                    project_root: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                    resumed_at: row.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        };

        Ok(rows)
    })
    .await
}

#[tauri::command]
pub async fn update_runtime_session(
    app: AppHandle,
    id: String,
    title: Option<String>,
    status: Option<String>,
    context: Option<String>,
    policy: Option<String>,
    thread_id: Option<String>,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    run_db(app, move |conn| {
        if let Some(t) = title {
            conn.execute(
                "UPDATE runtime_sessions SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![t, now, id],
            )?;
        }
        if let Some(s) = status {
            conn.execute(
                "UPDATE runtime_sessions SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![s, now, id],
            )?;
        }
        if let Some(c) = context {
            conn.execute(
                "UPDATE runtime_sessions SET context = ?1, updated_at = ?2 WHERE id = ?3",
                params![c, now, id],
            )?;
        }
        if let Some(p) = policy {
            conn.execute(
                "UPDATE runtime_sessions SET policy = ?1, updated_at = ?2 WHERE id = ?3",
                params![p, now, id],
            )?;
        }
        if let Some(tid) = thread_id {
            conn.execute(
                "UPDATE runtime_sessions SET thread_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![tid, now, id],
            )?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn resume_runtime_session(app: AppHandle, id: String) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    run_db(app, move |conn| {
        conn.execute(
            "UPDATE runtime_sessions SET status = 'running', resumed_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_runtime_session(app: AppHandle, id: String) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute("DELETE FROM session_events WHERE session_id = ?1", params![id])?;
        conn.execute("DELETE FROM runtime_sessions WHERE id = ?1", params![id])?;
        Ok(())
    })
    .await
}

// ============================================================================
// Session Event Commands
// ============================================================================

#[tauri::command]
pub async fn add_session_event(
    app: AppHandle,
    id: String,
    session_id: String,
    event_type: String,
    title: String,
    content: Option<String>,
    metadata: Option<String>,
    status: Option<String>,
) -> Result<SessionEvent, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let event_status = status.unwrap_or_else(|| "completed".to_string());

    let event = SessionEvent {
        id: id.clone(),
        session_id: session_id.clone(),
        event_type: event_type.clone(),
        title: title.clone(),
        content: content.clone(),
        metadata: metadata.clone(),
        status: event_status.clone(),
        created_at: now,
    };

    run_db(app, move |conn| {
        conn.execute(
            "INSERT INTO session_events (id, session_id, event_type, title, content, metadata, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, session_id, event_type, title, content, metadata, event_status, now],
        )?;

        // Touch the parent session's updated_at
        conn.execute(
            "UPDATE runtime_sessions SET updated_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )?;

        Ok(())
    })
    .await?;

    Ok(event)
}

#[tauri::command]
pub async fn get_session_events(
    app: AppHandle,
    session_id: String,
    limit: Option<i32>,
) -> Result<Vec<SessionEvent>, String> {
    run_db(app, move |conn| {
        let limit = limit.unwrap_or(500);
        let mut stmt = conn.prepare(
            "SELECT id, session_id, event_type, title, content, metadata, status, created_at
             FROM session_events WHERE session_id = ?1 ORDER BY created_at ASC LIMIT ?2",
        )?;

        let rows = stmt
            .query_map(params![session_id, limit], |row| {
                Ok(SessionEvent {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    event_type: row.get(2)?,
                    title: row.get(3)?,
                    content: row.get(4)?,
                    metadata: row.get(5)?,
                    status: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    })
    .await
}

#[tauri::command]
pub async fn update_session_event_status(
    app: AppHandle,
    id: String,
    status: String,
) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "UPDATE session_events SET status = ?1 WHERE id = ?2",
            params![status, id],
        )?;
        Ok(())
    })
    .await
}

// ============================================================================
// Helper
// ============================================================================

async fn run_db<T>(
    app: AppHandle,
    task: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(pool) = app.try_state::<DbPool>() {
            pool.with_connection(|conn| task(conn))
        } else {
            let conn = init_db(&app).map_err(|err| err.to_string())?;
            task(&conn).map_err(|err| err.to_string())
        }
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}
