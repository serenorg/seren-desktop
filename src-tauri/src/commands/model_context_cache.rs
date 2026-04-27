// ABOUTME: Tauri commands that persist per-model context windows learned from CLI metadata.
// ABOUTME: Lets compaction thresholds stay correct for new models without hand-edited catalogs.

use crate::services::database::{DbPool, init_db};
use rusqlite::{Connection, OptionalExtension, params};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn get_model_context_window(
    app: AppHandle,
    provider: String,
    model_id: String,
) -> Result<Option<i64>, String> {
    run_db(app, move |conn| {
        conn.query_row(
            "SELECT context_window FROM model_context_cache
             WHERE provider = ?1 AND model_id = ?2",
            params![provider, model_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
    })
    .await
}

#[tauri::command]
pub async fn record_model_context_window(
    app: AppHandle,
    provider: String,
    model_id: String,
    context_window: i64,
) -> Result<(), String> {
    if context_window <= 0 {
        return Err("context_window must be positive".into());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    run_db(app, move |conn| {
        conn.execute(
            "INSERT INTO model_context_cache (provider, model_id, context_window, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(provider, model_id) DO UPDATE SET
               context_window = excluded.context_window,
               updated_at = excluded.updated_at",
            params![provider, model_id, context_window, now],
        )?;
        Ok(())
    })
    .await
}

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
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use crate::services::database::setup_schema;
    use rusqlite::{Connection, params};

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    fn upsert(conn: &Connection, provider: &str, model_id: &str, context_window: i64, ts: i64) {
        conn.execute(
            "INSERT INTO model_context_cache (provider, model_id, context_window, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(provider, model_id) DO UPDATE SET
               context_window = excluded.context_window,
               updated_at = excluded.updated_at",
            params![provider, model_id, context_window, ts],
        )
        .unwrap();
    }

    fn read(conn: &Connection, provider: &str, model_id: &str) -> Option<(i64, i64)> {
        conn.query_row(
            "SELECT context_window, updated_at FROM model_context_cache
             WHERE provider = ?1 AND model_id = ?2",
            params![provider, model_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .ok()
    }

    #[test]
    fn roundtrip_returns_stored_context_window() {
        let conn = open();
        upsert(&conn, "anthropic", "claude-opus-4-7", 1_000_000, 100);

        let got = read(&conn, "anthropic", "claude-opus-4-7");
        assert_eq!(got, Some((1_000_000, 100)));
    }

    #[test]
    fn upsert_replaces_prior_value_for_same_key() {
        let conn = open();
        upsert(&conn, "anthropic", "claude-opus-4-7", 200_000, 100);
        upsert(&conn, "anthropic", "claude-opus-4-7", 1_000_000, 200);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM model_context_cache
                 WHERE provider = 'anthropic' AND model_id = 'claude-opus-4-7'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            read(&conn, "anthropic", "claude-opus-4-7"),
            Some((1_000_000, 200))
        );
    }
}
