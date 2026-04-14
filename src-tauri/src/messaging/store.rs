// ABOUTME: SQLite persistence for messaging conversations.
// ABOUTME: Maps (platform, chat_id) to conversation_id and stores message history.

use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct MessagingStore {
    conn: Mutex<Connection>,
}

impl MessagingStore {
    pub fn open(db_path: PathBuf) -> Result<Self, String> {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open messaging DB: {e}"))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS messaging_conversations (
                platform TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                model_id TEXT,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                PRIMARY KEY (platform, chat_id)
            );

            CREATE TABLE IF NOT EXISTS messaging_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE INDEX IF NOT EXISTS idx_msg_platform_chat
                ON messaging_messages (platform, chat_id);

            CREATE TABLE IF NOT EXISTS messaging_config (
                platform TEXT PRIMARY KEY,
                token_encrypted TEXT NOT NULL,
                allowed_user_id TEXT,
                phone_number_id TEXT,
                enabled INTEGER NOT NULL DEFAULT 1
            );",
        )
        .map_err(|e| format!("Failed to create messaging tables: {e}"))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get_or_create_conversation(
        &self,
        platform: &str,
        chat_id: &str,
    ) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let existing: Option<String> = conn
            .query_row(
                "SELECT conversation_id FROM messaging_conversations WHERE platform = ?1 AND chat_id = ?2",
                params![platform, chat_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(id) = existing {
            return Ok(id);
        }

        let conversation_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO messaging_conversations (platform, chat_id, conversation_id) VALUES (?1, ?2, ?3)",
            params![platform, chat_id, conversation_id],
        )
        .map_err(|e| format!("Failed to create messaging conversation: {e}"))?;

        Ok(conversation_id)
    }

    pub fn add_message(
        &self,
        platform: &str,
        chat_id: &str,
        role: &str,
        content: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO messaging_messages (platform, chat_id, role, content) VALUES (?1, ?2, ?3, ?4)",
            params![platform, chat_id, role, content],
        )
        .map_err(|e| format!("Failed to add messaging message: {e}"))?;
        Ok(())
    }

    pub fn get_recent_messages(
        &self,
        platform: &str,
        chat_id: &str,
        limit: usize,
    ) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT role, content FROM messaging_messages
                 WHERE platform = ?1 AND chat_id = ?2
                 ORDER BY id DESC LIMIT ?3",
            )
            .map_err(|e| format!("Failed to prepare query: {e}"))?;

        let rows = stmt
            .query_map(params![platform, chat_id, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to query messages: {e}"))?;

        let mut messages: Vec<(String, String)> = Vec::new();
        for row in rows {
            messages.push(row.map_err(|e| e.to_string())?);
        }
        messages.reverse();
        Ok(messages)
    }

    pub fn clear_conversation(
        &self,
        platform: &str,
        chat_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM messaging_messages WHERE platform = ?1 AND chat_id = ?2",
            params![platform, chat_id],
        )
        .map_err(|e| format!("Failed to clear conversation: {e}"))?;
        conn.execute(
            "DELETE FROM messaging_conversations WHERE platform = ?1 AND chat_id = ?2",
            params![platform, chat_id],
        )
        .map_err(|e| format!("Failed to remove conversation mapping: {e}"))?;
        Ok(())
    }

    pub fn save_platform_config(
        &self,
        platform: &str,
        token_encrypted: &str,
        allowed_user_id: Option<&str>,
        phone_number_id: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO messaging_config (platform, token_encrypted, allowed_user_id, phone_number_id, enabled)
             VALUES (?1, ?2, ?3, ?4, 1)",
            params![platform, token_encrypted, allowed_user_id, phone_number_id],
        )
        .map_err(|e| format!("Failed to save platform config: {e}"))?;
        Ok(())
    }

    pub fn get_platform_config(
        &self,
        platform: &str,
    ) -> Result<Option<PlatformConfig>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn
            .query_row(
                "SELECT token_encrypted, allowed_user_id, phone_number_id, enabled FROM messaging_config WHERE platform = ?1",
                params![platform],
                |row| {
                    Ok(PlatformConfig {
                        token_encrypted: row.get(0)?,
                        allowed_user_id: row.get(1)?,
                        phone_number_id: row.get(2)?,
                        enabled: row.get::<_, i32>(3)? != 0,
                    })
                },
            )
            .ok();
        Ok(result)
    }

    pub fn remove_platform_config(&self, platform: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM messaging_config WHERE platform = ?1",
            params![platform],
        )
        .map_err(|e| format!("Failed to remove platform config: {e}"))?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PlatformConfig {
    pub token_encrypted: String,
    pub allowed_user_id: Option<String>,
    pub phone_number_id: Option<String>,
    pub enabled: bool,
}
