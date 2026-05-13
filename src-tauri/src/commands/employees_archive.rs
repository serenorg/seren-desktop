// ABOUTME: Tauri commands for the local archived-employees registry.
// ABOUTME: Snapshots deleted virtual employees so the sidebar can still parent their chats.

use crate::services::database::{DbPool, init_db};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ArchivedEmployeeRow {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub mode: String,
    pub avatar_seed: String,
    pub archived_at: i64,
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

#[tauri::command]
pub async fn archive_employee(
    app: AppHandle,
    id: String,
    slug: String,
    name: String,
    mode: String,
    avatar_seed: String,
    archived_at: i64,
) -> Result<(), String> {
    run_db(app, move |conn| {
        // Re-archiving the same id is idempotent: refresh the snapshot so a
        // user who re-creates and re-deletes an employee sees the latest name
        // and avatar in their archive list.
        conn.execute(
            "INSERT INTO archived_employees
                (id, slug, name, mode, avatar_seed, archived_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                slug = excluded.slug,
                name = excluded.name,
                mode = excluded.mode,
                avatar_seed = excluded.avatar_seed,
                archived_at = excluded.archived_at",
            params![id, slug, name, mode, avatar_seed, archived_at],
        )?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn list_archived_employees(app: AppHandle) -> Result<Vec<ArchivedEmployeeRow>, String> {
    run_db(app, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, slug, name, mode, avatar_seed, archived_at
             FROM archived_employees
             ORDER BY archived_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ArchivedEmployeeRow {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    mode: row.get(3)?,
                    avatar_seed: row.get(4)?,
                    archived_at: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .await
}

#[tauri::command]
pub async fn delete_archived_employee(app: AppHandle, id: String) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute("DELETE FROM archived_employees WHERE id = ?1", params![id])?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::setup_schema;
    use rusqlite::Connection;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        setup_schema(&conn).expect("schema setup");
        conn
    }

    #[test]
    fn archive_roundtrip_idempotent_on_id() {
        let conn = open_test_db();

        let insert = |name: &str, archived_at: i64| {
            conn.execute(
                "INSERT INTO archived_employees
                    (id, slug, name, mode, avatar_seed, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    archived_at = excluded.archived_at",
                params![
                    "dep_1",
                    "research-assistant",
                    name,
                    "always_on",
                    "seed1",
                    archived_at
                ],
            )
            .expect("insert");
        };

        insert("First", 100);
        insert("First Renamed", 200);

        let (name, archived_at): (String, i64) = conn
            .query_row(
                "SELECT name, archived_at FROM archived_employees WHERE id = 'dep_1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read back");

        assert_eq!(name, "First Renamed");
        assert_eq!(archived_at, 200);
    }

    #[test]
    fn list_returns_newest_first_and_delete_removes_row() {
        let conn = open_test_db();

        for (id, archived_at) in [("a", 100i64), ("b", 300i64), ("c", 200i64)] {
            conn.execute(
                "INSERT INTO archived_employees
                    (id, slug, name, mode, avatar_seed, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, "slug", "name", "always_on", "seed", archived_at],
            )
            .expect("insert");
        }

        let mut stmt = conn
            .prepare("SELECT id FROM archived_employees ORDER BY archived_at DESC")
            .expect("prepare");
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect");

        assert_eq!(ids, vec!["b", "c", "a"]);

        conn.execute("DELETE FROM archived_employees WHERE id = 'b'", [])
            .expect("delete");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM archived_employees", [], |row| {
                row.get(0)
            })
            .expect("count");

        assert_eq!(count, 2);
    }

    #[test]
    fn cascade_delete_by_employee_removes_conversation_dependents() {
        let conn = open_test_db();

        // Seed two conversations for the target employee plus an unrelated
        // conversation that must survive the purge.
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, employee_id)
             VALUES ('c1', 'Chat 1', 100, 'dep_target'),
                    ('c2', 'Chat 2', 200, 'dep_target'),
                    ('c3', 'Other', 300, 'dep_other')",
            [],
        )
        .expect("insert conversations");

        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp)
             VALUES ('m1', 'c1', 'user', 'hi', 100),
                    ('m2', 'c1', 'assistant', 'hello', 101),
                    ('m3', 'c2', 'user', 'q', 200),
                    ('m4', 'c3', 'user', 'unrelated', 300)",
            [],
        )
        .expect("insert messages");

        conn.execute(
            "INSERT INTO input_history (conversation_id, timestamp, content)
             VALUES ('c1', 100, 'draft'), ('c3', 300, 'keep')",
            [],
        )
        .expect("insert input history");
        conn.execute(
            "INSERT INTO orchestration_plans (id, conversation_id, original_prompt, status, created_at)
             VALUES ('p1', 'c1', 'plan', 'active', 100),
                    ('p3', 'c3', 'plan', 'active', 300)",
            [],
        )
        .expect("insert plans");
        conn.execute(
            "INSERT INTO plan_subtasks (id, plan_id, prompt, task_type, worker_type, model_id, status, created_at)
             VALUES ('st1', 'p1', 'step', 'research', 'employee', 'm', 'pending', 100),
                    ('st3', 'p3', 'step', 'research', 'employee', 'm', 'pending', 300)",
            [],
        )
        .expect("insert subtasks");
        conn.execute(
            "INSERT INTO eval_signals (message_id, task_type, model_id, worker_type, satisfaction, created_at)
             VALUES ('m1', 'research', 'm', 'employee', 1, 100),
                    ('m4', 'research', 'm', 'employee', 1, 300)",
            [],
        )
        .expect("insert eval signals");
        conn.execute(
            "INSERT INTO thread_skill_override_state (thread_id, project_root)
             VALUES ('c1', '/tmp/project'), ('c3', '/tmp/project')",
            [],
        )
        .expect("insert override state");
        conn.execute(
            "INSERT INTO thread_skills (thread_id, project_root, skill_ref)
             VALUES ('c1', '/tmp/project', 'user:test'), ('c3', '/tmp/project', 'user:test')",
            [],
        )
        .expect("insert thread skills");
        conn.execute(
            "INSERT INTO runtime_sessions (id, title, status, environment, thread_id, created_at, updated_at)
             VALUES ('s1', 'Session', 'idle', 'browser', 'c1', 100, 100),
                    ('s3', 'Session', 'idle', 'browser', 'c3', 300, 300)",
            [],
        )
        .expect("insert sessions");
        conn.execute(
            "INSERT INTO session_events (id, session_id, event_type, title, status, created_at)
             VALUES ('se1', 's1', 'event', 'Event', 'completed', 100),
                    ('se3', 's3', 'event', 'Event', 'completed', 300)",
            [],
        )
        .expect("insert session events");

        let ids = ["c1".to_string(), "c2".to_string()];
        let deleted =
            crate::commands::chat::delete_conversation_records(&conn, &ids).expect("delete chats");

        assert_eq!(deleted, 2);

        let remaining_convos: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversations", [], |row| row.get(0))
            .expect("count conversations");
        assert_eq!(remaining_convos, 1);

        let remaining_messages: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .expect("count messages");
        assert_eq!(remaining_messages, 1);

        let surviving_id: String = conn
            .query_row("SELECT id FROM conversations", [], |row| row.get(0))
            .expect("surviving id");
        assert_eq!(surviving_id, "c3");

        let surviving_msg: String = conn
            .query_row("SELECT id FROM messages", [], |row| row.get(0))
            .expect("surviving msg");
        assert_eq!(surviving_msg, "m4");

        for table in [
            "input_history",
            "orchestration_plans",
            "plan_subtasks",
            "eval_signals",
            "thread_skill_override_state",
            "thread_skills",
            "runtime_sessions",
            "session_events",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count dependent table");
            assert_eq!(count, 1, "{table} should keep only unrelated rows");
        }
    }
}
