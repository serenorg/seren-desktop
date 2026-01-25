use crate::services::database::init_db;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const MAX_MESSAGES: i32 = 50;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StoredMessage {
  pub id: String,
  pub role: String,
  pub content: String,
  pub model: Option<String>,
  pub timestamp: i64,
}

#[tauri::command]
pub async fn save_message(
  app: AppHandle,
  id: String,
  role: String,
  content: String,
  model: Option<String>,
  timestamp: i64,
) -> Result<(), String> {
  run_db(app, move |conn| {
    conn.execute(
      "INSERT OR REPLACE INTO messages (id, role, content, model, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)",
      params![id, role, content, model, timestamp],
    )?;

    conn.execute(
      "DELETE FROM messages WHERE id NOT IN (
          SELECT id FROM messages ORDER BY timestamp DESC LIMIT ?1
      )",
      params![MAX_MESSAGES],
    )?;
    Ok(())
  })
  .await
}

#[tauri::command]
pub async fn get_messages(app: AppHandle, limit: i32) -> Result<Vec<StoredMessage>, String> {
  run_db(app, move |conn| {
    let mut stmt = conn.prepare(
      "SELECT id, role, content, model, timestamp
       FROM messages
       ORDER BY timestamp DESC
       LIMIT ?1",
    )?;

    let rows = stmt
      .query_map(params![limit.min(MAX_MESSAGES)], |row| {
        Ok(StoredMessage {
          id: row.get(0)?,
          role: row.get(1)?,
          content: row.get(2)?,
          model: row.get(3)?,
          timestamp: row.get(4)?,
        })
      })?
      .collect::<Result<Vec<_>, _>>()?;

    let mut ordered = rows;
    ordered.reverse();
    Ok(ordered)
  })
  .await
}

#[tauri::command]
pub async fn clear_history(app: AppHandle) -> Result<(), String> {
  run_db(app, move |conn| {
    conn.execute("DELETE FROM messages", [])?;
    Ok(())
  })
  .await
}

async fn run_db<T>(app: AppHandle, task: impl FnOnce(Connection) -> rusqlite::Result<T> + Send + 'static) -> Result<T, String>
where
  T: Send + 'static,
{
  tauri::async_runtime::spawn_blocking(move || {
    let conn = init_db(&app).map_err(|err| err.to_string())?;
    task(conn).map_err(|err| err.to_string())
  })
  .await
  .map_err(|err| err.to_string())?
}
