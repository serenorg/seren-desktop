// ABOUTME: Tauri commands for reading and switching the per-thread provider runtime binding.
// ABOUTME: switch_thread_provider mutates provider_session_runtime + conversations atomically.

use crate::services::database::{DbPool, init_db};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderSessionRuntime {
    pub thread_id: String,
    pub provider: String,
    pub model: Option<String>,
    pub native_session_id: Option<String>,
    pub resume_cursor_json: Option<String>,
    pub status: String,
    pub bootstrap_context: Option<String>,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn get_provider_session_runtime(
    app: AppHandle,
    thread_id: String,
) -> Result<Option<ProviderSessionRuntime>, String> {
    run_db(app, move |conn| {
        conn.query_row(
            "SELECT thread_id, provider, model, native_session_id, resume_cursor_json,
                    status, bootstrap_context, updated_at
             FROM provider_session_runtime
             WHERE thread_id = ?1",
            params![thread_id],
            |row| {
                Ok(ProviderSessionRuntime {
                    thread_id: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    native_session_id: row.get(3)?,
                    resume_cursor_json: row.get(4)?,
                    status: row.get(5)?,
                    bootstrap_context: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()
    })
    .await
}

/// Atomically rebind a thread to a new provider/model.
///
/// Updates `provider_session_runtime` and mirrors the compatibility columns
/// on `conversations` (selected_provider / selected_model) so existing read
/// paths that have not migrated to the runtime table yet still see the right
/// values during rollout.
///
/// The Phase-3 surface only handles chat-side providers — it intentionally
/// does not park or tear down a native-agent session, and it does not stamp
/// `agent_type` / `agent_session_id` on the conversation. Native-agent
/// switching (with its own resume cursor and bootstrap context handling)
/// lands in a later phase.
#[tauri::command]
pub async fn switch_thread_provider(
    app: AppHandle,
    thread_id: String,
    target_provider: String,
    target_model: Option<String>,
    bootstrap_context: Option<String>,
) -> Result<ProviderSessionRuntime, String> {
    if target_provider.trim().is_empty() {
        return Err("target_provider must not be empty".into());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    run_db(app, move |conn| {
        conn.execute_batch("BEGIN")?;
        let outcome = (|| -> rusqlite::Result<ProviderSessionRuntime> {
            // Reject switches against threads that do not exist so a caller
            // cannot create orphan runtime rows.
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM conversations WHERE id = ?1",
                params![thread_id],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }

            conn.execute(
                "INSERT INTO provider_session_runtime
                    (thread_id, provider, model, native_session_id,
                     resume_cursor_json, status, bootstrap_context, updated_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, 'active', ?4, ?5)
                 ON CONFLICT(thread_id) DO UPDATE SET
                    provider = excluded.provider,
                    model = excluded.model,
                    native_session_id = NULL,
                    resume_cursor_json = NULL,
                    status = 'active',
                    bootstrap_context = excluded.bootstrap_context,
                    updated_at = excluded.updated_at",
                params![thread_id, target_provider, target_model, bootstrap_context, now],
            )?;

            conn.execute(
                "UPDATE conversations
                 SET selected_provider = ?1,
                     selected_model = COALESCE(?2, selected_model)
                 WHERE id = ?3",
                params![target_provider, target_model, thread_id],
            )?;

            conn.query_row(
                "SELECT thread_id, provider, model, native_session_id,
                        resume_cursor_json, status, bootstrap_context, updated_at
                 FROM provider_session_runtime
                 WHERE thread_id = ?1",
                params![thread_id],
                |row| {
                    Ok(ProviderSessionRuntime {
                        thread_id: row.get(0)?,
                        provider: row.get(1)?,
                        model: row.get(2)?,
                        native_session_id: row.get(3)?,
                        resume_cursor_json: row.get(4)?,
                        status: row.get(5)?,
                        bootstrap_context: row.get(6)?,
                        updated_at: row.get(7)?,
                    })
                },
            )
        })();

        match outcome {
            Ok(row) => {
                conn.execute_batch("COMMIT")?;
                Ok(row)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
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

    fn seed_chat_thread(conn: &Connection, id: &str, provider: &str, model: &str) {
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, selected_provider, selected_model)
             VALUES (?1, 'Thread', 1000, 'chat', ?2, ?3)",
            params![id, provider, model],
        )
        .unwrap();
    }

    fn perform_switch(
        conn: &Connection,
        thread_id: &str,
        target_provider: &str,
        target_model: Option<&str>,
        bootstrap_context: Option<&str>,
        now: i64,
    ) {
        conn.execute_batch("BEGIN").unwrap();
        conn.execute(
            "INSERT INTO provider_session_runtime
                (thread_id, provider, model, native_session_id,
                 resume_cursor_json, status, bootstrap_context, updated_at)
             VALUES (?1, ?2, ?3, NULL, NULL, 'active', ?4, ?5)
             ON CONFLICT(thread_id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model,
                native_session_id = NULL,
                resume_cursor_json = NULL,
                status = 'active',
                bootstrap_context = excluded.bootstrap_context,
                updated_at = excluded.updated_at",
            params![thread_id, target_provider, target_model, bootstrap_context, now],
        )
        .unwrap();
        conn.execute(
            "UPDATE conversations
             SET selected_provider = ?1,
                 selected_model = COALESCE(?2, selected_model)
             WHERE id = ?3",
            params![target_provider, target_model, thread_id],
        )
        .unwrap();
        conn.execute_batch("COMMIT").unwrap();
    }

    #[test]
    fn switch_writes_runtime_row_and_mirrors_to_conversations() {
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        perform_switch(
            &conn,
            "t1",
            "seren-private",
            Some("private-model-id"),
            None,
            2000,
        );

        let (provider, model, status, updated_at): (String, String, String, i64) = conn
            .query_row(
                "SELECT provider, model, status, updated_at
                 FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(provider, "seren-private");
        assert_eq!(model, "private-model-id");
        assert_eq!(status, "active");
        assert_eq!(updated_at, 2000);

        let (mirror_provider, mirror_model): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT selected_provider, selected_model FROM conversations WHERE id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(mirror_provider, Some("seren-private".to_string()));
        assert_eq!(mirror_model, Some("private-model-id".to_string()));
    }

    #[test]
    fn switch_with_null_model_preserves_prior_selected_model() {
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        perform_switch(&conn, "t1", "seren-private", None, None, 2000);

        let mirror_model: Option<String> = conn
            .query_row(
                "SELECT selected_model FROM conversations WHERE id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // Conversation kept its prior model because the switch did not name a new one.
        assert_eq!(mirror_model, Some("claude-sonnet-4".to_string()));

        // The runtime row records the absent model as NULL — explicit
        // unbound. Phase 4 UI will always pair provider+model.
        let runtime_model: Option<String> = conn
            .query_row(
                "SELECT model FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(runtime_model, None);
    }

    #[test]
    fn switch_persists_bootstrap_context_for_native_agent_consumption() {
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        let bootstrap = "Previous turns:\n[user]: hi\n[assistant]: hello";
        perform_switch(
            &conn,
            "t1",
            "claude-code",
            Some("claude-sonnet-4"),
            Some(bootstrap),
            2000,
        );

        let stored: Option<String> = conn
            .query_row(
                "SELECT bootstrap_context FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored.as_deref(), Some(bootstrap));
    }

    #[test]
    fn switch_clears_bootstrap_when_the_new_binding_does_not_need_one() {
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        // First switch carries a bootstrap (transcript recap for an agent).
        perform_switch(
            &conn,
            "t1",
            "claude-code",
            Some("claude-sonnet-4"),
            Some("recap"),
            2000,
        );
        // Subsequent switch back to a chat provider has no bootstrap and
        // must overwrite the prior value rather than keep it stale.
        perform_switch(&conn, "t1", "seren", Some("claude-sonnet-4"), None, 3000);

        let stored: Option<String> = conn
            .query_row(
                "SELECT bootstrap_context FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, None);
    }

    #[test]
    fn switch_replaces_prior_runtime_row_for_the_same_thread() {
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        perform_switch(&conn, "t1", "seren-private", Some("a"), None, 2000);
        perform_switch(&conn, "t1", "seren", Some("b"), None, 3000);

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let (provider, model, updated_at): (String, String, i64) = conn
            .query_row(
                "SELECT provider, model, updated_at
                 FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(provider, "seren");
        assert_eq!(model, "b");
        assert_eq!(updated_at, 3000);
    }
}
