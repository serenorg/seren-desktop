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
    expected_updated_at: Option<i64>,
) -> Result<ProviderSessionRuntime, String> {
    if target_provider.trim().is_empty() {
        return Err("target_provider must not be empty".into());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;

    // Sentinels surfaced inside the transaction closure so the rollback
    // path can unwind cleanly. The outer await arm rewrites each into a
    // stable error string the frontend can match on, distinct from any
    // genuine driver error.
    const THREAD_NOT_FOUND_SENTINEL: &str = "__seren__thread_not_found";
    const STALE_RUNTIME_SENTINEL: &str = "__seren__stale_runtime_binding";
    let thread_id_for_err = thread_id.clone();

    let result = run_db(app, move |conn| {
        // IMMEDIATE so the RESERVED lock is taken before the optimistic
        // SELECT, closing the SELECT-then-UPSERT window that a default
        // DEFERRED begin would leave open across connections.
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| -> rusqlite::Result<ProviderSessionRuntime> {
            // Reject switches against threads that do not exist so a caller
            // cannot create orphan runtime rows.
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM conversations WHERE id = ?1",
                params![thread_id],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(rusqlite::Error::InvalidParameterName(
                    THREAD_NOT_FOUND_SENTINEL.to_string(),
                ));
            }

            // Optimistic concurrency token: when the caller passes the
            // `updated_at` they last observed, the current row must still
            // match. A `None` keeps the original last-writer-wins shape so
            // callers that have not adopted the check are unaffected. A
            // `Some(v)` against a missing row fails too — the caller
            // assumed there was a row to compare against.
            if let Some(expected) = expected_updated_at {
                let current: Option<i64> = conn
                    .query_row(
                        "SELECT updated_at FROM provider_session_runtime WHERE thread_id = ?1",
                        params![thread_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if current != Some(expected) {
                    return Err(rusqlite::Error::InvalidParameterName(
                        STALE_RUNTIME_SENTINEL.to_string(),
                    ));
                }
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
    .await;

    // rusqlite renders InvalidParameterName(s) as "Invalid parameter name: <s>",
    // so the rendered message ends with the sentinel string. An ends_with check
    // is tighter than substring matching against an arbitrary driver error that
    // happens to mention the sentinel in the middle of its message.
    match result {
        Ok(row) => Ok(row),
        Err(msg) if msg.ends_with(THREAD_NOT_FOUND_SENTINEL) => {
            Err(format!("thread not found: {}", thread_id_for_err))
        }
        Err(msg) if msg.ends_with(STALE_RUNTIME_SENTINEL) => Err(format!(
            "stale runtime binding for thread {}: another window changed the provider; refresh and retry",
            thread_id_for_err,
        )),
        Err(msg) => Err(msg),
    }
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

    /// Mirror of the production switch closure body so tests can drive the
    /// same transaction logic without a Tauri AppHandle. Returns
    /// `Err("thread_not_found")` when the conversation row is missing and
    /// `Err("stale_runtime_binding")` when the optimistic token does not
    /// match the current row.
    fn try_perform_switch(
        conn: &Connection,
        thread_id: &str,
        target_provider: &str,
        target_model: Option<&str>,
        bootstrap_context: Option<&str>,
        expected_updated_at: Option<i64>,
        now: i64,
    ) -> Result<(), String> {
        use rusqlite::OptionalExtension;
        conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
        let inner = (|| -> rusqlite::Result<()> {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM conversations WHERE id = ?1",
                params![thread_id],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(rusqlite::Error::InvalidParameterName(
                    "__seren__thread_not_found".to_string(),
                ));
            }
            if let Some(expected) = expected_updated_at {
                let current: Option<i64> = conn
                    .query_row(
                        "SELECT updated_at FROM provider_session_runtime WHERE thread_id = ?1",
                        params![thread_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if current != Some(expected) {
                    return Err(rusqlite::Error::InvalidParameterName(
                        "__seren__stale_runtime_binding".to_string(),
                    ));
                }
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
            Ok(())
        })();
        match inner {
            Ok(()) => {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(rusqlite::Error::InvalidParameterName(s))
                if s == "__seren__thread_not_found" =>
            {
                let _ = conn.execute_batch("ROLLBACK");
                Err("thread_not_found".to_string())
            }
            Err(rusqlite::Error::InvalidParameterName(s))
                if s == "__seren__stale_runtime_binding" =>
            {
                let _ = conn.execute_batch("ROLLBACK");
                Err("stale_runtime_binding".to_string())
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e.to_string())
            }
        }
    }

    fn perform_switch(
        conn: &Connection,
        thread_id: &str,
        target_provider: &str,
        target_model: Option<&str>,
        bootstrap_context: Option<&str>,
        now: i64,
    ) {
        try_perform_switch(
            conn,
            thread_id,
            target_provider,
            target_model,
            bootstrap_context,
            None,
            now,
        )
        .unwrap();
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

    #[test]
    fn switch_against_missing_thread_returns_thread_not_found_and_writes_nothing() {
        let conn = open();

        // No conversation seeded — the guard must reject before any write.
        let err = try_perform_switch(
            &conn,
            "ghost",
            "seren",
            Some("m"),
            None,
            None,
            2000,
        )
        .unwrap_err();
        assert_eq!(err, "thread_not_found");

        // Transaction must have rolled back, so no orphan runtime row exists.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = 'ghost'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn sequential_switches_collapse_to_last_writer_wins() {
        // The DbPool serializes through a connection mutex, so the practical
        // race shape for two near-simultaneous switches is "second wins after
        // first commits". Pin that behavior down: no row duplication, latest
        // values reflect the latest switch.
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        try_perform_switch(
            &conn,
            "t1",
            "seren-private",
            Some("m1"),
            Some("a"),
            None,
            2000,
        )
        .unwrap();
        try_perform_switch(
            &conn,
            "t1",
            "claude-code",
            Some("m2"),
            None,
            None,
            3000,
        )
        .unwrap();

        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);

        let (provider, model, bootstrap, updated_at): (String, String, Option<String>, i64) =
            conn.query_row(
                "SELECT provider, model, bootstrap_context, updated_at
                 FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(provider, "claude-code");
        assert_eq!(model, "m2");
        assert_eq!(bootstrap, None);
        assert_eq!(updated_at, 3000);
    }

    #[test]
    fn expected_updated_at_match_lets_the_switch_proceed() {
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        try_perform_switch(
            &conn,
            "t1",
            "seren-private",
            Some("m1"),
            None,
            None,
            2000,
        )
        .unwrap();

        // Caller passes the just-observed updated_at — the second switch
        // should land cleanly.
        try_perform_switch(
            &conn,
            "t1",
            "claude-code",
            Some("m2"),
            None,
            Some(2000),
            3000,
        )
        .unwrap();

        let (provider, updated_at): (String, i64) = conn
            .query_row(
                "SELECT provider, updated_at FROM provider_session_runtime
                 WHERE thread_id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(provider, "claude-code");
        assert_eq!(updated_at, 3000);
    }

    #[test]
    fn expected_updated_at_mismatch_rejects_and_writes_nothing() {
        // Window A switches first; window B has a stale view and tries to
        // switch with the older updated_at. Reject the stale write rather
        // than silently clobber what window A just wrote.
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        try_perform_switch(
            &conn,
            "t1",
            "seren-private",
            Some("m1"),
            None,
            None,
            2000,
        )
        .unwrap();
        // Window A switches again, advancing the token.
        try_perform_switch(
            &conn,
            "t1",
            "claude-code",
            Some("m2"),
            None,
            Some(2000),
            3000,
        )
        .unwrap();

        // Window B still thinks the runtime is at updated_at=2000.
        let err = try_perform_switch(
            &conn,
            "t1",
            "codex",
            Some("m3"),
            None,
            Some(2000),
            4000,
        )
        .unwrap_err();
        assert_eq!(err, "stale_runtime_binding");

        let (provider, model, updated_at): (String, String, i64) = conn
            .query_row(
                "SELECT provider, model, updated_at FROM provider_session_runtime
                 WHERE thread_id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        // Window B's stale switch must not have landed.
        assert_eq!(provider, "claude-code");
        assert_eq!(model, "m2");
        assert_eq!(updated_at, 3000);
    }

    #[test]
    fn expected_updated_at_with_no_existing_row_rejects() {
        // Caller asserted there was a row to compare against, but there
        // isn't — refuse rather than silently insert. This catches the
        // case where window B believed it was racing window A's switch
        // when in fact no switch had ever occurred (e.g. the runtime row
        // was just rolled back).
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");

        let err = try_perform_switch(
            &conn,
            "t1",
            "seren-private",
            Some("m1"),
            None,
            Some(1234),
            2000,
        )
        .unwrap_err();
        assert_eq!(err, "stale_runtime_binding");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
}
