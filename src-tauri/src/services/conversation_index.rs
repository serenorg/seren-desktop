// ABOUTME: Local index for chat/agent conversation search — FTS5 (exact) + sqlite-vec (semantic).
// ABOUTME: Chunks message content into a dedicated indexes/conversations.db, mirroring the transcript stack.

use crate::services::vector_store::{EMBEDDING_DIM, init_sqlite_vec};
use rusqlite::{Connection, Result, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Target characters per chunk (mirrors the transcript chunker's CHUNK_CHAR_BUDGET).
const CHUNK_CHAR_BUDGET: usize = 1500;
/// Max chunks indexed per message. Real history has a single 11.7M-char message;
/// without a cap one row would explode index size, embedding cost, and latency.
/// We index a bounded head and skip the tail.
const MAX_CHUNKS_PER_MESSAGE: usize = 12;

/// A conversation search hit: the matched chunk's location, denormalized display
/// attributes, text, and distance. FTS hits carry distance 0.0; semantic hits
/// carry the vector distance.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHit {
    pub message_id: String,
    pub conversation_id: String,
    pub kind: String,
    pub role: String,
    pub title: Option<String>,
    pub agent_type: Option<String>,
    pub project_root: Option<String>,
    pub timestamp: i64,
    pub seq: i64,
    pub text: String,
    pub distance: f32,
}

/// A message ready to be (re)indexed. Carries the denormalized attributes so both
/// search paths filter/display against `conv_chunks` alone — no cross-database join
/// back to the managed `chat.db`.
#[derive(Debug, Clone)]
pub struct IndexableMessage {
    pub message_id: String,
    pub conversation_id: String,
    pub kind: String,
    pub role: String,
    pub title: Option<String>,
    pub agent_type: Option<String>,
    pub project_root: Option<String>,
    pub is_archived: bool,
    pub timestamp: i64,
    pub content: String,
}

/// Filters pushed into SQL `WHERE` (not post-filtered in JS) so counts/paging stay
/// correct at scale. Empty `kinds` means "all kinds".
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub project_root: Option<String>,
    #[serde(default)]
    pub after_ms: Option<i64>,
    #[serde(default)]
    pub before_ms: Option<i64>,
    #[serde(default)]
    pub include_archived: bool,
}

/// A chunk of a single message, in order.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkInput {
    pub seq: i64,
    pub text: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn conversation_index_db_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir")
        .join("indexes")
        .join("conversations.db")
}

/// Create the conversation index tables on a connection that already has the
/// sqlite-vec extension loaded.
fn create_tables(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS conv_chunks (
            id              INTEGER PRIMARY KEY,
            message_id      TEXT    NOT NULL,
            conversation_id TEXT    NOT NULL,
            kind            TEXT    NOT NULL,
            role            TEXT    NOT NULL,
            title           TEXT,
            agent_type      TEXT,
            project_root    TEXT,
            is_archived     INTEGER NOT NULL DEFAULT 0,
            timestamp       INTEGER NOT NULL,
            seq             INTEGER NOT NULL,
            text            TEXT    NOT NULL,
            indexed_at      INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conv_chunks_message ON conv_chunks(message_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conv_chunks_conversation ON conv_chunks(conversation_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conv_chunks_ts ON conv_chunks(timestamp DESC)",
        [],
    )?;
    // Exact path. A plain (non-external-content) FTS5 table whose rowid mirrors
    // conv_chunks.id — supports INSERT with an explicit rowid and DELETE by rowid,
    // avoiding the external-content sync footguns.
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts USING fts5(text)",
        [],
    )?;
    // Semantic path (dim reuses EMBEDDING_DIM = 1536, same as transcript/code index).
    conn.execute(
        &format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS conv_embeddings USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding float[{EMBEDDING_DIM}]
            )"
        ),
        [],
    )?;
    Ok(())
}

/// Open (creating if needed) the conversation index DB with sqlite-vec loaded.
/// Uses `configure_connection` (WAL + busy_timeout) — mandatory, since backfill,
/// search, and index-on-write all touch this file concurrently; without it they
/// hit "database is locked", surfacing as spurious "No matches".
pub fn open_index_db(app: &AppHandle) -> Result<Connection> {
    init_sqlite_vec();
    let path = conversation_index_db_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(path)?;
    crate::services::database::configure_connection(&conn)?;
    create_tables(&conn)?;
    Ok(conn)
}

fn embedding_to_blob(embedding: &[f32]) -> Vec<u8> {
    embedding
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn fts_document(title: Option<&str>, text: &str) -> String {
    match title.map(str::trim).filter(|value| !value.is_empty()) {
        Some(title) => format!("{title}\n{text}"),
        None => text.to_string(),
    }
}

/// Split a message into embeddable chunks on a character budget, breaking on
/// whitespace where possible. Capped at `MAX_CHUNKS_PER_MESSAGE`; only the head
/// of a giant message is indexed. Empty/whitespace-only content yields no chunks.
pub fn chunk_message(content: &str) -> Vec<ChunkInput> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    // Bound work and memory: only the head is ever indexed for giant messages,
    // so never materialize more than the cap's worth of characters.
    let cap_chars = MAX_CHUNKS_PER_MESSAGE * CHUNK_CHAR_BUDGET;
    let mut chars: Vec<char> = trimmed.chars().take(cap_chars + 1).collect();
    let truncated = chars.len() > cap_chars;
    if truncated {
        chars.truncate(cap_chars);
        log::warn!("conversation_index: message exceeded {cap_chars} chars; indexing head only");
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    let mut seq = 0i64;
    while start < chars.len() && chunks.len() < MAX_CHUNKS_PER_MESSAGE {
        let mut end = (start + CHUNK_CHAR_BUDGET).min(chars.len());
        // Prefer to break at a whitespace boundary near the budget (look back up
        // to 200 chars) so words/lines aren't split mid-token.
        if end < chars.len() {
            let lookback = end.saturating_sub(200);
            if let Some(ws) = (lookback..end).rev().find(|&i| chars[i].is_whitespace()) {
                if ws > start {
                    end = ws + 1;
                }
            }
        }
        let text: String = chars[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !text.is_empty() {
            chunks.push(ChunkInput { seq, text });
            seq += 1;
        }
        start = end;
    }
    chunks
}

fn delete_message_chunks_tx(tx: &Connection, message_id: &str) -> Result<()> {
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM conv_chunks WHERE message_id = ?1")?;
        stmt.query_map(params![message_id], |row| row.get(0))?
            .filter_map(|row| row.ok())
            .collect()
    };
    for id in &ids {
        tx.execute("DELETE FROM conv_fts WHERE rowid = ?1", params![id])?;
        tx.execute(
            "DELETE FROM conv_embeddings WHERE chunk_id = ?1",
            params![id],
        )?;
    }
    tx.execute(
        "DELETE FROM conv_chunks WHERE message_id = ?1",
        params![message_id],
    )?;
    Ok(())
}

/// Re-index one message: drop its existing chunks (+ FTS + embeddings) and write
/// fresh chunk rows. Embeddings are NOT computed here — they attach later, async.
/// Handles edits/upserts (delete-then-insert keyed by `message_id`).
pub fn reindex_message(conn: &Connection, msg: &IndexableMessage) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    delete_message_chunks_tx(&tx, &msg.message_id)?;
    let chunks = chunk_message(&msg.content);
    let now = now_ms();
    for chunk in &chunks {
        tx.execute(
            "INSERT INTO conv_chunks
                (message_id, conversation_id, kind, role, title, agent_type,
                 project_root, is_archived, timestamp, seq, text, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                msg.message_id,
                msg.conversation_id,
                msg.kind,
                msg.role,
                msg.title,
                msg.agent_type,
                msg.project_root,
                msg.is_archived,
                msg.timestamp,
                chunk.seq,
                chunk.text,
                now,
            ],
        )?;
        let chunk_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO conv_fts (rowid, text) VALUES (?1, ?2)",
            params![chunk_id, fts_document(msg.title.as_deref(), &chunk.text)],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Drop all chunks (+ FTS + embeddings) for a single message.
pub fn delete_message_chunks(conn: &Connection, message_id: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    delete_message_chunks_tx(&tx, message_id)?;
    tx.commit()
}

/// Drop all chunks (+ FTS + embeddings) for a whole conversation.
pub fn delete_conversation_chunks(conn: &Connection, conversation_id: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM conv_chunks WHERE conversation_id = ?1")?;
        stmt.query_map(params![conversation_id], |row| row.get(0))?
            .filter_map(|row| row.ok())
            .collect()
    };
    for id in &ids {
        tx.execute("DELETE FROM conv_fts WHERE rowid = ?1", params![id])?;
        tx.execute(
            "DELETE FROM conv_embeddings WHERE chunk_id = ?1",
            params![id],
        )?;
    }
    tx.execute(
        "DELETE FROM conv_chunks WHERE conversation_id = ?1",
        params![conversation_id],
    )?;
    tx.commit()
}

/// Clear the entire index (called from "clear all history").
pub fn clear_all_chunks(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM conv_embeddings", [])?;
    tx.execute("DELETE FROM conv_fts", [])?;
    tx.execute("DELETE FROM conv_chunks", [])?;
    tx.commit()
}

/// Update the denormalized display/filter columns for a conversation's chunks,
/// without re-chunking. Called from archive/rename paths so filters and labels
/// stay correct. Any `None` argument leaves that column unchanged.
pub fn update_conversation_meta(
    conn: &Connection,
    conversation_id: &str,
    title: Option<&str>,
    is_archived: Option<bool>,
) -> Result<()> {
    if let Some(title) = title {
        conn.execute(
            "UPDATE conv_chunks SET title = ?1 WHERE conversation_id = ?2",
            params![title, conversation_id],
        )?;
        let rows: Vec<(i64, String)> = {
            let mut stmt =
                conn.prepare("SELECT id, text FROM conv_chunks WHERE conversation_id = ?1")?;
            stmt.query_map(params![conversation_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .filter_map(|row| row.ok())
            .collect()
        };
        for (chunk_id, text) in rows {
            conn.execute(
                "UPDATE conv_fts SET text = ?1 WHERE rowid = ?2",
                params![fts_document(Some(title), &text), chunk_id],
            )?;
        }
    }
    if let Some(is_archived) = is_archived {
        conn.execute(
            "UPDATE conv_chunks SET is_archived = ?1 WHERE conversation_id = ?2",
            params![is_archived, conversation_id],
        )?;
    }
    Ok(())
}

/// Attach an embedding to an existing chunk (upsert by chunk id). The caller must
/// validate `embedding.len() == EMBEDDING_DIM`.
pub fn insert_embedding(conn: &Connection, chunk_id: i64, embedding: &[f32]) -> Result<()> {
    if embedding.len() != EMBEDDING_DIM {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "expected embedding dim {EMBEDDING_DIM}, got {}",
            embedding.len()
        )));
    }
    conn.execute(
        "INSERT OR REPLACE INTO conv_embeddings (chunk_id, embedding) VALUES (?1, ?2)",
        params![chunk_id, embedding_to_blob(embedding)],
    )?;
    Ok(())
}

/// The next batch of chunks with no embedding yet (for the async backfill).
pub fn unembedded_chunk_batch(conn: &Connection, limit: usize) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, text FROM conv_chunks
         WHERE id NOT IN (SELECT chunk_id FROM conv_embeddings)
         ORDER BY id
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit as i64], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(|row| row.ok())
        .collect();
    Ok(rows)
}

/// Message ids that already have indexed chunks (so the FTS backfill can diff).
pub fn indexed_message_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT message_id FROM conv_chunks")?;
    let ids = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|row| row.ok())
        .collect();
    Ok(ids)
}

/// Build the shared filter `WHERE` fragment (leading " AND ...") plus its params,
/// so both search paths filter identically in SQL.
fn build_filter_clause(filters: &SearchFilters) -> (String, Vec<Value>) {
    let mut clause = String::new();
    let mut vals: Vec<Value> = Vec::new();
    if !filters.kinds.is_empty() {
        let placeholders = filters
            .kinds
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        clause.push_str(&format!(" AND c.kind IN ({placeholders})"));
        for kind in &filters.kinds {
            vals.push(Value::Text(kind.clone()));
        }
    }
    if let Some(project_root) = &filters.project_root {
        clause.push_str(" AND c.project_root = ?");
        vals.push(Value::Text(project_root.clone()));
    }
    if let Some(after) = filters.after_ms {
        clause.push_str(" AND c.timestamp >= ?");
        vals.push(Value::Integer(after));
    }
    if let Some(before) = filters.before_ms {
        clause.push_str(" AND c.timestamp <= ?");
        vals.push(Value::Integer(before));
    }
    if !filters.include_archived {
        clause.push_str(" AND c.is_archived = 0");
    }
    (clause, vals)
}

/// Turn raw user input into a phrase-safe FTS5 MATCH string: wrap each
/// whitespace-separated term in double quotes (escaping embedded quotes) so FTS5
/// operators (AND/OR/NOT/NEAR, `*`, `"`, `:`, `-`, parens) are matched literally
/// and never error on hostile input. Empty input yields an empty string.
fn fts_query(raw: &str) -> String {
    raw.split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn row_to_hit(row: &rusqlite::Row) -> rusqlite::Result<ConversationHit> {
    Ok(ConversationHit {
        message_id: row.get(0)?,
        conversation_id: row.get(1)?,
        kind: row.get(2)?,
        role: row.get(3)?,
        title: row.get(4)?,
        agent_type: row.get(5)?,
        project_root: row.get(6)?,
        timestamp: row.get(7)?,
        seq: row.get(8)?,
        text: row.get(9)?,
        distance: row.get(10)?,
    })
}

const HIT_COLUMNS: &str = "c.message_id, c.conversation_id, c.kind, c.role, c.title, \
     c.agent_type, c.project_root, c.timestamp, c.seq, c.text";

/// Exact full-text search over indexed chunks, bm25-ranked. Offline/unauthenticated.
/// Returns hits with distance 0.0.
pub fn search_fts(
    conn: &Connection,
    query: &str,
    filters: &SearchFilters,
    limit: usize,
) -> Result<Vec<ConversationHit>> {
    let match_query = fts_query(query);
    if match_query.is_empty() {
        return Ok(Vec::new());
    }
    let (clause, filter_vals) = build_filter_clause(filters);
    let sql = format!(
        "SELECT {HIT_COLUMNS}, 0.0 AS distance
         FROM conv_fts f JOIN conv_chunks c ON c.id = f.rowid
         WHERE conv_fts MATCH ?{clause}
         ORDER BY bm25(conv_fts)
         LIMIT ?"
    );
    let mut binds: Vec<Value> = Vec::with_capacity(filter_vals.len() + 2);
    binds.push(Value::Text(match_query));
    binds.extend(filter_vals);
    binds.push(Value::Integer(limit as i64));

    let mut stmt = conn.prepare(&sql)?;
    let hits = stmt
        .query_map(params_from_iter(binds), row_to_hit)?
        .filter_map(|row| row.ok())
        .collect();
    Ok(hits)
}

/// Semantic KNN search over embedded chunks. The KNN runs in an isolated subquery
/// (vec0 requires the MATCH + `k` together on the vtable and nothing else), then
/// the joined metadata is filtered and re-limited. We over-fetch so filtering
/// still yields up to `limit` rows.
pub fn search_semantic(
    conn: &Connection,
    query_embedding: &[f32],
    filters: &SearchFilters,
    limit: usize,
) -> Result<Vec<ConversationHit>> {
    let (clause, filter_vals) = build_filter_clause(filters);
    let over_fetch = ((limit * 5).max(50)).min(500) as i64;
    let sql = format!(
        "SELECT {HIT_COLUMNS}, knn.distance
         FROM (
            SELECT chunk_id, distance FROM conv_embeddings
            WHERE embedding MATCH ? AND k = ?
         ) knn
         JOIN conv_chunks c ON c.id = knn.chunk_id
         WHERE 1=1{clause}
         ORDER BY knn.distance
         LIMIT ?"
    );
    let mut binds: Vec<Value> = Vec::with_capacity(filter_vals.len() + 3);
    binds.push(Value::Blob(embedding_to_blob(query_embedding)));
    binds.push(Value::Integer(over_fetch));
    binds.extend(filter_vals);
    binds.push(Value::Integer(limit as i64));

    let mut stmt = conn.prepare(&sql)?;
    let hits = stmt
        .query_map(params_from_iter(binds), row_to_hit)?
        .filter_map(|row| row.ok())
        .collect();
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        init_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        create_tables(&conn).unwrap();
        conn
    }

    fn msg(id: &str, conv: &str, kind: &str, role: &str, content: &str) -> IndexableMessage {
        IndexableMessage {
            message_id: id.to_string(),
            conversation_id: conv.to_string(),
            kind: kind.to_string(),
            role: role.to_string(),
            title: Some(format!("title-{conv}")),
            agent_type: if kind == "agent" {
                Some("claude-code".into())
            } else {
                None
            },
            project_root: Some("/repo".into()),
            is_archived: false,
            timestamp: 1000,
            content: content.to_string(),
        }
    }

    fn unit_vec(index: usize) -> Vec<f32> {
        let mut embedding = vec![0.0f32; EMBEDDING_DIM];
        embedding[index] = 1.0;
        embedding
    }

    fn chunk_id_for(conn: &Connection, message_id: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM conv_chunks WHERE message_id = ?1 ORDER BY seq LIMIT 1",
            params![message_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    // T0.2: the whole exact-path design assumes FTS5 is compiled into the bundled
    // sqlite. Prove it rather than trust the docs.
    #[test]
    fn fts5_is_available() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE VIRTUAL TABLE t USING fts5(x)", [])
            .expect("fts5 must be available in bundled sqlite");
    }

    #[test]
    fn fts_ranks_and_matches_words() {
        let conn = test_conn();
        reindex_message(
            &conn,
            &msg("m1", "c1", "chat", "user", "the updater signing failed"),
        )
        .unwrap();
        reindex_message(
            &conn,
            &msg("m2", "c2", "chat", "user", "weather chatter today"),
        )
        .unwrap();

        let hits = search_fts(&conn, "signing", &SearchFilters::default(), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "m1");
        assert_eq!(hits[0].distance, 0.0);
    }

    #[test]
    fn fts_matches_conversation_titles() {
        let conn = test_conn();
        let mut message = msg("m1", "c1", "chat", "user", "body does not contain the term");
        message.title = Some("Release signing notes".to_string());
        reindex_message(&conn, &message).unwrap();

        let hits = search_fts(&conn, "release", &SearchFilters::default(), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "m1");
    }

    #[test]
    fn fts_query_is_injection_safe() {
        let conn = test_conn();
        reindex_message(
            &conn,
            &msg(
                "m1",
                "c1",
                "chat",
                "assistant",
                r#"set createUpdaterArtifacts: true AND ship"#,
            ),
        )
        .unwrap();

        // Queries containing FTS operators / metacharacters must not error.
        for query in [
            r#"createUpdaterArtifacts"#,
            r#"AND"#,
            r#"true*"#,
            r#"foo"bar"#,
            r#"( OR )"#,
            r#"NEAR("#,
        ] {
            let hits = search_fts(&conn, query, &SearchFilters::default(), 10);
            assert!(hits.is_ok(), "query {query:?} must not error");
        }
        // A term that is present matches; one that is absent does not.
        assert_eq!(
            search_fts(
                &conn,
                "createUpdaterArtifacts",
                &SearchFilters::default(),
                10
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            search_fts(&conn, "nonexistentterm", &SearchFilters::default(), 10)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn semantic_ranks_nearest_first() {
        let conn = test_conn();
        reindex_message(&conn, &msg("m1", "c1", "chat", "user", "budget decision")).unwrap();
        reindex_message(&conn, &msg("m2", "c2", "chat", "user", "weather chatter")).unwrap();
        insert_embedding(&conn, chunk_id_for(&conn, "m1"), &unit_vec(0)).unwrap();
        insert_embedding(&conn, chunk_id_for(&conn, "m2"), &unit_vec(1)).unwrap();

        let mut query = vec![0.0f32; EMBEDDING_DIM];
        query[0] = 0.9;
        query[1] = 0.1;
        let hits = search_semantic(&conn, &query, &SearchFilters::default(), 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].message_id, "m1");
        assert!(hits[0].distance <= hits[1].distance);
    }

    #[test]
    fn filters_apply() {
        let conn = test_conn();
        // chat / agent, two projects, one archived — exercised on BOTH paths.
        let mut chat = msg("m1", "c1", "chat", "user", "alpha signing token");
        chat.project_root = Some("/repoA".into());
        reindex_message(&conn, &chat).unwrap();

        let mut agent = msg("m2", "c2", "agent", "assistant", "alpha signing token");
        agent.project_root = Some("/repoB".into());
        reindex_message(&conn, &agent).unwrap();

        let mut archived = msg("m3", "c3", "chat", "user", "alpha signing token");
        archived.is_archived = true;
        archived.project_root = Some("/repoA".into());
        reindex_message(&conn, &archived).unwrap();

        // Attach embeddings so the semantic path returns the same population.
        insert_embedding(&conn, chunk_id_for(&conn, "m1"), &unit_vec(0)).unwrap();
        insert_embedding(&conn, chunk_id_for(&conn, "m2"), &unit_vec(0)).unwrap();
        insert_embedding(&conn, chunk_id_for(&conn, "m3"), &unit_vec(0)).unwrap();
        let query = unit_vec(0);

        let run = |f: &SearchFilters| {
            let mut fts: Vec<String> = search_fts(&conn, "alpha", f, 50)
                .unwrap()
                .into_iter()
                .map(|h| h.message_id)
                .collect();
            let mut sem: Vec<String> = search_semantic(&conn, &query, f, 50)
                .unwrap()
                .into_iter()
                .map(|h| h.message_id)
                .collect();
            fts.sort();
            sem.sort();
            (fts, sem)
        };

        // Default: archived excluded → m1, m2.
        let (fts, sem) = run(&SearchFilters::default());
        assert_eq!(fts, vec!["m1", "m2"]);
        assert_eq!(sem, vec!["m1", "m2"]);

        // kind = chat only → m1 (m3 archived).
        let (fts, sem) = run(&SearchFilters {
            kinds: vec!["chat".into()],
            ..Default::default()
        });
        assert_eq!(fts, vec!["m1"]);
        assert_eq!(sem, vec!["m1"]);

        // project = /repoB → m2.
        let (fts, sem) = run(&SearchFilters {
            project_root: Some("/repoB".into()),
            ..Default::default()
        });
        assert_eq!(fts, vec!["m2"]);
        assert_eq!(sem, vec!["m2"]);

        // include archived → m1, m2, m3.
        let (fts, sem) = run(&SearchFilters {
            include_archived: true,
            ..Default::default()
        });
        assert_eq!(fts, vec!["m1", "m2", "m3"]);
        assert_eq!(sem, vec!["m1", "m2", "m3"]);
    }

    #[test]
    fn delete_and_reindex_cascade() {
        let conn = test_conn();
        reindex_message(
            &conn,
            &msg("m1", "c1", "chat", "user", "original signing text"),
        )
        .unwrap();
        insert_embedding(&conn, chunk_id_for(&conn, "m1"), &unit_vec(0)).unwrap();

        // Edit (upsert): reindex replaces text; the old text is gone.
        reindex_message(
            &conn,
            &msg("m1", "c1", "chat", "user", "revised deployment text"),
        )
        .unwrap();
        assert_eq!(
            search_fts(&conn, "signing", &SearchFilters::default(), 10)
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            search_fts(&conn, "deployment", &SearchFilters::default(), 10)
                .unwrap()
                .len(),
            1
        );
        // Reindex dropped the stale embedding too (chunk is unembedded again).
        assert!(
            unembedded_chunk_batch(&conn, 10)
                .unwrap()
                .iter()
                .any(|(_, t)| t.contains("deployment"))
        );

        // Delete by message: chunks + fts + embeddings all gone.
        insert_embedding(&conn, chunk_id_for(&conn, "m1"), &unit_vec(0)).unwrap();
        delete_message_chunks(&conn, "m1").unwrap();
        assert_eq!(
            search_fts(&conn, "deployment", &SearchFilters::default(), 10)
                .unwrap()
                .len(),
            0
        );
        assert!(indexed_message_ids(&conn).unwrap().is_empty());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM conv_embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn delete_conversation_and_clear_all() {
        let conn = test_conn();
        reindex_message(&conn, &msg("m1", "c1", "chat", "user", "one signing")).unwrap();
        reindex_message(
            &conn,
            &msg("m2", "c1", "assistant", "assistant", "two signing"),
        )
        .unwrap();
        reindex_message(&conn, &msg("m3", "c2", "chat", "user", "three signing")).unwrap();

        delete_conversation_chunks(&conn, "c1").unwrap();
        let remaining: Vec<String> = indexed_message_ids(&conn).unwrap();
        assert_eq!(remaining, vec!["m3"]);

        clear_all_chunks(&conn).unwrap();
        assert!(indexed_message_ids(&conn).unwrap().is_empty());
    }

    #[test]
    fn update_meta_reflects_in_filters_and_hits() {
        let conn = test_conn();
        reindex_message(&conn, &msg("m1", "c1", "chat", "user", "signing thread")).unwrap();

        update_conversation_meta(&conn, "c1", Some("Renamed"), Some(true)).unwrap();
        // Title reflected on hits (archived, so include_archived to see it).
        let hits = search_fts(
            &conn,
            "signing",
            &SearchFilters {
                include_archived: true,
                ..Default::default()
            },
            10,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title.as_deref(), Some("Renamed"));
        // Now archived → excluded by the default filter.
        assert_eq!(
            search_fts(&conn, "signing", &SearchFilters::default(), 10)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn chunking_caps_and_skips_empty() {
        assert!(chunk_message("   \n  ").is_empty());
        let one = chunk_message("hello world");
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].seq, 0);

        // A message far larger than the cap yields exactly MAX_CHUNKS_PER_MESSAGE.
        let giant = "word ".repeat(CHUNK_CHAR_BUDGET * MAX_CHUNKS_PER_MESSAGE);
        let chunks = chunk_message(&giant);
        assert_eq!(chunks.len(), MAX_CHUNKS_PER_MESSAGE);
        assert_eq!(
            chunks.last().unwrap().seq,
            (MAX_CHUNKS_PER_MESSAGE - 1) as i64
        );
    }
}
