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
/// Cross-category switches also mirror `kind`, `agent_type`, and
/// `agent_model_id`; the frontend owns native session spawn/tear-down after
/// this transaction commits.
#[tauri::command]
pub async fn switch_thread_provider(
    app: AppHandle,
    thread_id: String,
    target_provider: String,
    target_model: Option<String>,
    target_cwd: Option<String>,
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

            // Mirror compatibility columns so existing read paths that have
            // not migrated to the runtime table still see the right values.
            // A cross-category switch flips `kind` and stamps `agent_type`
            // accordingly so `thread.store::selectThread` routes to the
            // right shell, and clears `agent_session_id` so the TS spawn
            // path creates a fresh native session (the prior session
            // belonged to a different agent type and is no longer valid).
            // `agent_model_id` and `agent_cwd` are mirrored on the agent
            // branch and cleared on the chat branch so the row's agent-*
            // columns are coherent with `kind` rather than leaving stale
            // agent metadata on a now-chat row. `agent_cwd` lets the
            // sidebar group the freshly-flipped agent row by the right
            // project before the native spawn callback fires.
            // The `selected_model` mirror uses COALESCE so a switch that
            // does not name a new model keeps the conversation's current
            // model in the compatibility column; the runtime row itself
            // stores the explicit value (NULL if unbound).
            let target_kind = if is_native_agent_provider(&target_provider) {
                "agent"
            } else {
                "chat"
            };
            let target_agent_type: Option<&str> = if target_kind == "agent" {
                Some(target_provider.as_str())
            } else {
                None
            };
            conn.execute(
                "UPDATE conversations
                 SET kind = ?1,
                     agent_type = ?2,
                     agent_session_id = NULL,
                     agent_model_id = CASE WHEN ?1 = 'agent'
                         THEN COALESCE(?3, agent_model_id)
                         ELSE NULL END,
                     agent_cwd = CASE WHEN ?1 = 'agent'
                         THEN COALESCE(?6, agent_cwd)
                         ELSE NULL END,
                     selected_provider = ?4,
                     selected_model = COALESCE(?3, selected_model)
                 WHERE id = ?5",
                params![
                    target_kind,
                    target_agent_type,
                    target_model,
                    target_provider,
                    thread_id,
                    target_cwd,
                ],
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

/// The external-agent runtimes (claude-code / codex / gemini) that own
/// their own native session and render through `AgentChat`, vs a
/// chat-routed provider (seren / seren-private / anthropic / openai)
/// that renders through `ChatContent`.
///
/// The frontend `@/services/providers` module is the single source of
/// truth for this categorization; we mirror the list here because the
/// switch command needs to flip `conversations.kind` accordingly, and
/// the unified conversation reader needs to derive `kind` from the live
/// runtime binding. Adding a new external agent on either side without
/// updating the other will cause threads bound to that agent to route
/// to the wrong shell.
pub(crate) const NATIVE_AGENT_PROVIDERS: &[&str] = &["claude-code", "codex", "gemini"];

/// SQL CASE expression that derives a thread's effective `kind` from
/// `provider_session_runtime.provider`, falling back to the stored
/// `conversations.kind` column when no binding row exists. Embedded as
/// a literal so SQLite's planner sees real string constants in the
/// IN-list rather than parameter bind values.
///
/// The IN-list must match [`NATIVE_AGENT_PROVIDERS`]. A drift-guard
/// test in this module asserts that invariant.
pub(crate) const DERIVED_KIND_CASE_SQL: &str = "CASE \
     WHEN psr.provider IS NULL THEN c.kind \
     WHEN psr.provider IN ('claude-code', 'codex', 'gemini') THEN 'agent' \
     ELSE 'chat' \
     END";

pub(crate) fn is_native_agent_provider(provider: &str) -> bool {
    NATIVE_AGENT_PROVIDERS.contains(&provider)
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
        target_cwd: Option<&str>,
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
            // Mirror compat columns. See production path for the rationale.
            let target_kind = if super::is_native_agent_provider(target_provider) {
                "agent"
            } else {
                "chat"
            };
            let target_agent_type: Option<&str> =
                if target_kind == "agent" { Some(target_provider) } else { None };
            conn.execute(
                "UPDATE conversations
                 SET kind = ?1,
                     agent_type = ?2,
                     agent_session_id = NULL,
                     agent_model_id = CASE WHEN ?1 = 'agent'
                         THEN COALESCE(?3, agent_model_id)
                         ELSE NULL END,
                     agent_cwd = CASE WHEN ?1 = 'agent'
                         THEN COALESCE(?6, agent_cwd)
                         ELSE NULL END,
                     selected_provider = ?4,
                     selected_model = COALESCE(?3, selected_model)
                 WHERE id = ?5",
                params![
                    target_kind,
                    target_agent_type,
                    target_model,
                    target_provider,
                    thread_id,
                    target_cwd,
                ],
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
            None,
            bootstrap_context,
            None,
            now,
        )
        .unwrap();
    }

    #[test]
    fn derived_kind_sql_in_list_matches_native_agent_providers() {
        // The SQL CASE expression embeds the native-agent provider IDs as a
        // literal IN-list so the planner sees real string constants. Pin the
        // invariant that the SQL fragment and the Rust array list the same
        // providers so a one-sided edit fails loudly instead of silently
        // misclassifying threads.
        for provider in super::NATIVE_AGENT_PROVIDERS {
            let needle = format!("'{provider}'");
            assert!(
                super::DERIVED_KIND_CASE_SQL.contains(&needle),
                "DERIVED_KIND_CASE_SQL missing provider {provider}",
            );
        }
        // Also assert the IN-list does not name a provider that is not in
        // the array - prevents a typo from drifting the other direction.
        let in_open = super::DERIVED_KIND_CASE_SQL.find("IN (").unwrap();
        let in_close = super::DERIVED_KIND_CASE_SQL[in_open..].find(')').unwrap();
        let in_body = &super::DERIVED_KIND_CASE_SQL[in_open + 4..in_open + in_close];
        let listed: Vec<&str> = in_body
            .split(',')
            .map(|s| s.trim().trim_matches('\''))
            .collect();
        assert_eq!(
            listed.len(),
            super::NATIVE_AGENT_PROVIDERS.len(),
            "DERIVED_KIND_CASE_SQL IN-list arity mismatch with NATIVE_AGENT_PROVIDERS",
        );
        for p in &listed {
            assert!(
                super::NATIVE_AGENT_PROVIDERS.contains(p),
                "DERIVED_KIND_CASE_SQL lists provider {p} not in NATIVE_AGENT_PROVIDERS",
            );
        }
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
            None,
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

    fn read_conv_compat(
        conn: &Connection,
        thread_id: &str,
    ) -> (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) {
        conn.query_row(
            "SELECT kind, agent_type, agent_session_id, agent_model_id,
                    selected_provider, selected_model
             FROM conversations WHERE id = ?1",
            params![thread_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap()
    }

    fn read_agent_cwd(conn: &Connection, thread_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT agent_cwd FROM conversations WHERE id = ?1",
            params![thread_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn switch_into_native_agent_flips_kind_and_stamps_agent_type() {
        let conn = open();
        seed_chat_thread(&conn, "t1", "seren", "claude-sonnet-4");
        // Simulate a stale agent_session_id left over from a prior bind so
        // we can verify the switch clears it (TS spawn must start fresh).
        conn.execute(
            "UPDATE conversations SET agent_session_id = 'stale-session' WHERE id = 't1'",
            [],
        )
        .unwrap();

        try_perform_switch(
            &conn,
            "t1",
            "claude-code",
            Some("claude-sonnet-4"),
            Some("/tmp/proj"),
            Some("recap"),
            None,
            2000,
        )
        .unwrap();

        let (kind, agent_type, agent_session_id, agent_model_id, selected_provider, selected_model) =
            read_conv_compat(&conn, "t1");
        assert_eq!(kind, "agent");
        assert_eq!(agent_type, Some("claude-code".to_string()));
        // The stale native session id must be cleared so the TS spawn path
        // creates a fresh session rather than trying to resume a session
        // that belonged to a different agent type.
        assert_eq!(agent_session_id, None);
        // agent_model_id mirrors the model on agent threads.
        assert_eq!(agent_model_id, Some("claude-sonnet-4".to_string()));
        // Chat-side compat columns still carry the latest values so
        // historical readers don't see a sudden NULL.
        assert_eq!(selected_provider, Some("claude-code".to_string()));
        assert_eq!(selected_model, Some("claude-sonnet-4".to_string()));
        // agent_cwd is stamped at switch time so the sidebar can group the
        // freshly-flipped row by project before the native spawn callback
        // populates the rest of the agent metadata.
        assert_eq!(read_agent_cwd(&conn, "t1"), Some("/tmp/proj".to_string()));
    }

    #[test]
    fn switch_back_to_chat_clears_agent_type_and_session() {
        let conn = open();
        // Seed an agent thread directly so the reverse switch is exercised.
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type,
                                        agent_session_id, agent_model_id, agent_cwd,
                                        selected_provider, selected_model)
             VALUES ('t1', 'Thread', 1000, 'agent', 'claude-code',
                     'live-session', 'claude-sonnet-4', '/tmp/proj',
                     'claude-code', 'claude-sonnet-4')",
            [],
        )
        .unwrap();

        try_perform_switch(
            &conn,
            "t1",
            "seren",
            Some("anthropic/claude-sonnet-4"),
            None,
            None,
            None,
            2000,
        )
        .unwrap();

        let (
            kind,
            agent_type,
            agent_session_id,
            agent_model_id,
            selected_provider,
            selected_model,
        ) = read_conv_compat(&conn, "t1");
        assert_eq!(kind, "chat");
        // agent_type cleared so the chat shell does not see a stale agent
        // hint that could route it into AgentChat.
        assert_eq!(agent_type, None);
        // Native session id cleared so the prior CLI session is not picked
        // up by a future agent switch on the same thread.
        assert_eq!(agent_session_id, None);
        // agent_model_id cleared to keep the agent-* columns coherent with
        // the new kind. A future query that joins on agent_model_id will
        // not pick up a stale value from a now-chat row.
        assert_eq!(agent_model_id, None);
        assert_eq!(selected_provider, Some("seren".to_string()));
        assert_eq!(selected_model, Some("anthropic/claude-sonnet-4".to_string()));
        // agent_cwd cleared on the chat branch for the same coherence reason.
        assert_eq!(read_agent_cwd(&conn, "t1"), None);
    }

    #[test]
    fn switch_with_null_cwd_preserves_existing_agent_cwd() {
        // The mirror uses COALESCE on the agent branch so a switch that
        // does not name a new cwd keeps the existing value. This matters
        // for agent->agent switches where the cwd is already correct and
        // the caller does not need to re-stamp it.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type,
                                        agent_session_id, agent_model_id, agent_cwd,
                                        selected_provider, selected_model)
             VALUES ('t1', 'Thread', 1000, 'agent', 'claude-code',
                     'live-session', 'claude-sonnet-4', '/tmp/proj',
                     'claude-code', 'claude-sonnet-4')",
            [],
        )
        .unwrap();

        try_perform_switch(
            &conn,
            "t1",
            "codex",
            Some("codex-mid"),
            None,
            None,
            None,
            2000,
        )
        .unwrap();

        assert_eq!(read_agent_cwd(&conn, "t1"), Some("/tmp/proj".to_string()));
    }

    #[test]
    fn agent_to_agent_switch_with_new_cwd_overwrites_existing_value() {
        // COALESCE on the agent branch lets a fresh cwd land on top of the
        // prior one. This is the path a TS caller takes when an
        // agent->agent switch picks up a different project root than the
        // current row carries.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type,
                                        agent_session_id, agent_model_id, agent_cwd,
                                        selected_provider, selected_model)
             VALUES ('t1', 'Thread', 1000, 'agent', 'claude-code',
                     'live-session', 'claude-sonnet-4', '/tmp/old-proj',
                     'claude-code', 'claude-sonnet-4')",
            [],
        )
        .unwrap();

        try_perform_switch(
            &conn,
            "t1",
            "codex",
            Some("codex-mid"),
            Some("/tmp/new-proj"),
            None,
            None,
            2000,
        )
        .unwrap();

        assert_eq!(read_agent_cwd(&conn, "t1"), Some("/tmp/new-proj".to_string()));
    }

    #[test]
    fn chat_branch_clears_agent_cwd_even_when_target_cwd_supplied() {
        // The chat branch of the agent_cwd mirror is `ELSE NULL`, so even a
        // misbehaving caller passing target_cwd on a chat-bound switch
        // cannot leave a stale agent_cwd on the now-chat row.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type,
                                        agent_session_id, agent_model_id, agent_cwd,
                                        selected_provider, selected_model)
             VALUES ('t1', 'Thread', 1000, 'agent', 'claude-code',
                     'live-session', 'claude-sonnet-4', '/tmp/proj',
                     'claude-code', 'claude-sonnet-4')",
            [],
        )
        .unwrap();

        try_perform_switch(
            &conn,
            "t1",
            "seren",
            Some("anthropic/claude-sonnet-4"),
            Some("/tmp/should-be-ignored"),
            None,
            None,
            2000,
        )
        .unwrap();

        assert_eq!(read_agent_cwd(&conn, "t1"), None);
    }

    #[test]
    fn agent_to_agent_type_change_updates_agent_type_and_clears_session() {
        // claude-code -> codex: the agent_type stamp must follow the new
        // provider and the prior native session id must be cleared so a
        // codex spawn does not try to resume a claude-code session.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type,
                                        agent_session_id, agent_model_id,
                                        selected_provider, selected_model)
             VALUES ('t1', 'Thread', 1000, 'agent', 'claude-code',
                     'claude-session', 'claude-sonnet-4', 'claude-code', 'claude-sonnet-4')",
            [],
        )
        .unwrap();

        try_perform_switch(&conn, "t1", "codex", Some("codex-mid"), None, None, None, 2000)
            .unwrap();

        let (kind, agent_type, agent_session_id, agent_model_id, _, _) =
            read_conv_compat(&conn, "t1");
        assert_eq!(kind, "agent");
        assert_eq!(agent_type, Some("codex".to_string()));
        assert_eq!(agent_session_id, None);
        assert_eq!(agent_model_id, Some("codex-mid".to_string()));
    }

    #[test]
    fn agent_to_same_agent_type_still_clears_native_session() {
        // Pin down the contract: every switch through this command resets
        // the native session id, even when the agent type is unchanged.
        // The runtime row already drops native_session_id unconditionally,
        // so the compat column must do the same to stay in sync.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type,
                                        agent_session_id, agent_model_id,
                                        selected_provider, selected_model)
             VALUES ('t1', 'Thread', 1000, 'agent', 'claude-code',
                     'live-session', 'claude-sonnet-4', 'claude-code', 'claude-sonnet-4')",
            [],
        )
        .unwrap();

        try_perform_switch(
            &conn,
            "t1",
            "claude-code",
            Some("claude-haiku-4"),
            None,
            None,
            None,
            2000,
        )
        .unwrap();

        let (kind, agent_type, agent_session_id, agent_model_id, _, _) =
            read_conv_compat(&conn, "t1");
        assert_eq!(kind, "agent");
        assert_eq!(agent_type, Some("claude-code".to_string()));
        assert_eq!(agent_session_id, None);
        assert_eq!(agent_model_id, Some("claude-haiku-4".to_string()));
    }

    #[test]
    fn intra_category_switch_preserves_kind() {
        // Seren -> seren-private must NOT flip kind to agent, and an
        // agent->agent switch must NOT flip kind to chat.
        let conn = open();
        seed_chat_thread(&conn, "chat1", "seren", "claude-sonnet-4");
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type,
                                        selected_provider, selected_model)
             VALUES ('agent1', 'Agent', 1000, 'agent', 'codex', 'codex', 'codex-mid')",
            [],
        )
        .unwrap();

        try_perform_switch(
            &conn,
            "chat1",
            "seren-private",
            Some("private-mid"),
            None,
            None,
            None,
            2000,
        )
        .unwrap();
        try_perform_switch(
            &conn,
            "agent1",
            "claude-code",
            Some("claude-sonnet-4"),
            None,
            Some("recap"),
            None,
            3000,
        )
        .unwrap();

        let chat = read_conv_compat(&conn, "chat1");
        assert_eq!(chat.0, "chat");
        assert_eq!(chat.1, None);
        assert_eq!(chat.4, Some("seren-private".to_string()));

        let agent = read_conv_compat(&conn, "agent1");
        assert_eq!(agent.0, "agent");
        assert_eq!(agent.1, Some("claude-code".to_string()));
        assert_eq!(agent.4, Some("claude-code".to_string()));
    }
}
