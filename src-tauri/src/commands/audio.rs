// ABOUTME: Tauri commands for Meeting Mode persistence and transcript history.
// ABOUTME: Stores meetings and transcript segments without persisting raw audio.

use crate::audio::capture::to_mono_16k;
use crate::audio::chunker::Chunk;
use crate::audio::cleanup::{build_cleanup_prompt, build_transform_prompt};
use crate::audio::detect::{probe_running_processes, should_start_capture};
use crate::audio::llm::{CompletionRequest, complete};
use crate::audio::merge::merge_segments;
use crate::audio::notes::{ParsedNotes, generate_notes};
use crate::audio::pipeline::CaptureRegistry;
use crate::audio::templates::{BUILT_IN_MEETING_TEMPLATES, MeetingTemplate};
use crate::audio::transcribe::{
    GatewayTranscriber, RetryConfig, TranscribeError, transcribe_chunk_with_retry,
};
use crate::audio::types::{Meeting, MeetingStatus, SegmentStatus, Speaker, TranscriptSegment};
use crate::orchestrator::types::SkillRef;
use crate::services::database::DbPool;
use rusqlite::{Connection, OptionalExtension, Result, params};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[tauri::command]
pub async fn create_meeting(
    app: AppHandle,
    title: String,
    source_app: Option<String>,
    started_at: Option<i64>,
    template_id: Option<String>,
) -> Result<Meeting, String> {
    let now = now_ms();
    let meeting = NewMeeting {
        id: Uuid::new_v4().to_string(),
        title,
        source_app,
        started_at: started_at.unwrap_or(now),
        template_id,
        now,
    };

    run_db(app, move |conn| insert_meeting(conn, meeting)).await
}

#[tauri::command]
pub async fn get_meeting(app: AppHandle, id: String) -> Result<Option<Meeting>, String> {
    run_db(app, move |conn| select_meeting(conn, &id)).await
}

#[tauri::command]
pub async fn list_meetings(app: AppHandle, limit: Option<i32>) -> Result<Vec<Meeting>, String> {
    run_db(app, move |conn| select_meetings(conn, limit.unwrap_or(50))).await
}

#[tauri::command]
pub async fn update_meeting_status(
    app: AppHandle,
    id: String,
    status: MeetingStatus,
    ended_at: Option<i64>,
) -> Result<(), String> {
    run_db(app, move |conn| {
        update_meeting_status_record(conn, &id, status, ended_at, now_ms())
    })
    .await
}

#[tauri::command]
pub async fn update_meeting_notes(
    app: AppHandle,
    id: String,
    notes_markdown: String,
    notes_struct_json: String,
) -> Result<(), String> {
    run_db(app, move |conn| {
        set_meeting_notes_record(conn, &id, &notes_markdown, &notes_struct_json)
    })
    .await
}

fn set_meeting_notes_record(
    conn: &Connection,
    id: &str,
    markdown: &str,
    struct_json: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE meetings
         SET notes_markdown = ?1, notes_struct_json = ?2, status = ?3, updated_at = ?4
         WHERE id = ?5",
        params![
            markdown,
            struct_json,
            MeetingStatus::NotesReady.as_str(),
            now_ms(),
            id
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn set_meeting_routed_skill(
    app: AppHandle,
    id: String,
    routed_skill_slug: Option<String>,
    agent_conversation_id: Option<String>,
) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "UPDATE meetings
             SET routed_skill_slug = ?1, agent_conversation_id = ?2, updated_at = ?3
             WHERE id = ?4",
            params![routed_skill_slug, agent_conversation_id, now_ms(), id],
        )?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn append_transcript_segment(
    app: AppHandle,
    meeting_id: String,
    seq: i64,
    speaker: Speaker,
    text: String,
    start_ms: i64,
    end_ms: i64,
    status: SegmentStatus,
) -> Result<TranscriptSegment, String> {
    let segment = NewTranscriptSegment {
        id: Uuid::new_v4().to_string(),
        meeting_id,
        seq,
        speaker,
        text,
        start_ms,
        end_ms,
        status,
        created_at: now_ms(),
    };

    run_db(app, move |conn| insert_transcript_segment(conn, segment)).await
}

#[tauri::command]
pub async fn get_transcript_segments(
    app: AppHandle,
    meeting_id: String,
) -> Result<Vec<TranscriptSegment>, String> {
    run_db(app, move |conn| {
        select_transcript_segments(conn, &meeting_id)
    })
    .await
}

// --- Capture lifecycle + Tier-1 intelligence -------------------------------

#[tauri::command]
pub async fn start_meeting_capture(
    app: AppHandle,
    registry: State<'_, CaptureRegistry>,
    meeting_id: String,
) -> Result<(), String> {
    registry.start(&app, &meeting_id);
    Ok(())
}

#[tauri::command]
pub async fn push_capture_frame(
    registry: State<'_, CaptureRegistry>,
    meeting_id: String,
    speaker: Speaker,
    samples: Vec<i16>,
    channels: u16,
    sample_rate: u32,
) -> Result<(), String> {
    let normalized = to_mono_16k(&samples, channels.max(1), sample_rate);
    registry.push_frame(&meeting_id, speaker, normalized);
    Ok(())
}

#[tauri::command]
pub async fn stop_meeting_capture(
    app: AppHandle,
    registry: State<'_, CaptureRegistry>,
    meeting_id: String,
) -> Result<(), String> {
    registry.stop(&meeting_id).await;
    let ended = now_ms();
    let id = meeting_id;
    run_db(app, move |conn| {
        update_meeting_status_record(conn, &id, MeetingStatus::Transcribing, Some(ended), ended)
    })
    .await
}

#[tauri::command]
pub async fn generate_meeting_notes(
    app: AppHandle,
    meeting_id: String,
    model: String,
    template_prompt: String,
    vocabulary: Vec<String>,
) -> Result<ParsedNotes, String> {
    let lookup = meeting_id.clone();
    let segments =
        run_db(app.clone(), move |conn| select_transcript_segments(conn, &lookup)).await?;
    let transcript = assemble_transcript(segments);
    if transcript.trim().is_empty() {
        return Err("no transcript to summarize".to_string());
    }

    let parsed = generate_notes(&app, model, &transcript, &template_prompt, &vocabulary).await?;
    let struct_json = serde_json::to_string(&parsed.structured).map_err(|err| err.to_string())?;
    let markdown = parsed.markdown.clone();
    let id = meeting_id;
    run_db(app, move |conn| {
        set_meeting_notes_record(conn, &id, &markdown, &struct_json)
    })
    .await?;
    Ok(parsed)
}

#[tauri::command]
pub async fn get_meeting_transcript_text(
    app: AppHandle,
    meeting_id: String,
) -> Result<String, String> {
    let segments = run_db(app, move |conn| select_transcript_segments(conn, &meeting_id)).await?;
    Ok(assemble_transcript(segments))
}

/// Return the slugs of installed skills tagged to handle meetings (0 / 1 / many).
#[tauri::command]
pub fn select_meeting_skills(skills: Vec<SkillRef>) -> Vec<String> {
    crate::orchestrator::classifier::select_meeting_skills(&skills)
}

#[tauri::command]
pub fn list_meeting_templates() -> Vec<MeetingTemplate> {
    BUILT_IN_MEETING_TEMPLATES.to_vec()
}

/// Probe running processes and decide whether a meeting capture should arm.
/// mic-in-use detection is not portable, so the decision relies on the
/// allowlist (see `probe_running_processes`).
#[tauri::command]
pub fn meeting_autodetect(allowlist: Vec<String>) -> bool {
    let processes = probe_running_processes();
    should_start_capture(&processes, false, &allowlist)
}

// --- Dictation (shares the transcribe + cleanup engines with Meeting Mode) --

/// Transcribe a single dictation chunk; returns "" for silence rather than erroring.
#[tauri::command]
pub async fn transcribe_pcm(
    app: AppHandle,
    samples: Vec<i16>,
    channels: u16,
    sample_rate: u32,
) -> Result<String, String> {
    let normalized = to_mono_16k(&samples, channels.max(1), sample_rate);
    if normalized.is_empty() {
        return Ok(String::new());
    }
    let chunk = Chunk {
        start_ms: 0,
        end_ms: 0,
        samples: normalized,
    };
    let transcriber = GatewayTranscriber::new(app);
    match transcribe_chunk_with_retry(&transcriber, &chunk, RetryConfig::default()).await {
        Ok(text) => Ok(text),
        Err(TranscribeError::Empty) => Ok(String::new()),
        Err(err) => Err(err.to_string()),
    }
}

/// Polish dictated text through the shared cleanup engine + custom vocabulary.
#[tauri::command]
pub async fn cleanup_dictation_text(
    app: AppHandle,
    text: String,
    model: String,
    vocabulary: Vec<String>,
) -> Result<String, String> {
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    let prompt = build_cleanup_prompt(&text, &vocabulary);
    complete(
        &app,
        CompletionRequest {
            model,
            system: None,
            prompt,
        },
    )
    .await
}

/// Edit-by-voice: transform a selection per a spoken instruction.
#[tauri::command]
pub async fn transform_selection(
    app: AppHandle,
    selection: String,
    instruction: String,
    model: String,
    vocabulary: Vec<String>,
) -> Result<String, String> {
    if selection.trim().is_empty() {
        return Err("nothing selected to transform".to_string());
    }
    let prompt = build_transform_prompt(&selection, &instruction, &vocabulary);
    complete(
        &app,
        CompletionRequest {
            model,
            system: None,
            prompt,
        },
    )
    .await
}

/// Assemble persisted segments into a chronological "Me/Them" transcript.
fn assemble_transcript(segments: Vec<TranscriptSegment>) -> String {
    let (me, them): (Vec<_>, Vec<_>) = segments
        .into_iter()
        .partition(|segment| segment.speaker == Speaker::Me);
    merge_segments(me, them)
        .into_iter()
        .filter(|segment| segment.status == SegmentStatus::Ok && !segment.text.trim().is_empty())
        .map(|segment| {
            let speaker = match segment.speaker {
                Speaker::Me => "Me",
                Speaker::Them => "Them",
            };
            format!("{speaker}: {}", segment.text.trim())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone)]
pub struct NewMeeting {
    pub id: String,
    pub title: String,
    pub source_app: Option<String>,
    pub started_at: i64,
    pub template_id: Option<String>,
    pub now: i64,
}

#[derive(Debug, Clone)]
pub struct NewTranscriptSegment {
    pub id: String,
    pub meeting_id: String,
    pub seq: i64,
    pub speaker: Speaker,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub status: SegmentStatus,
    pub created_at: i64,
}

pub fn insert_meeting(conn: &Connection, meeting: NewMeeting) -> Result<Meeting> {
    conn.execute(
        "INSERT INTO meetings (
            id, title, source_app, started_at, ended_at, status, template_id,
            routed_skill_slug, agent_conversation_id, notes_markdown,
            notes_struct_json, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, NULL, NULL, NULL, NULL, ?7, ?7)",
        params![
            meeting.id,
            meeting.title,
            meeting.source_app,
            meeting.started_at,
            MeetingStatus::Capturing.as_str(),
            meeting.template_id,
            meeting.now
        ],
    )?;

    select_meeting(conn, &meeting.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn select_meeting(conn: &Connection, id: &str) -> Result<Option<Meeting>> {
    conn.query_row(
        "SELECT id, title, source_app, started_at, ended_at, status, template_id,
                routed_skill_slug, agent_conversation_id, notes_markdown,
                notes_struct_json, created_at, updated_at
         FROM meetings
         WHERE id = ?1",
        params![id],
        row_to_meeting,
    )
    .optional()
}

pub fn select_meetings(conn: &Connection, limit: i32) -> Result<Vec<Meeting>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, source_app, started_at, ended_at, status, template_id,
                routed_skill_slug, agent_conversation_id, notes_markdown,
                notes_struct_json, created_at, updated_at
         FROM meetings
         ORDER BY started_at DESC
         LIMIT ?1",
    )?;

    stmt.query_map(params![limit], row_to_meeting)?
        .collect::<Result<Vec<_>>>()
}

pub fn update_meeting_status_record(
    conn: &Connection,
    id: &str,
    status: MeetingStatus,
    ended_at: Option<i64>,
    updated_at: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE meetings SET status = ?1, ended_at = ?2, updated_at = ?3 WHERE id = ?4",
        params![status.as_str(), ended_at, updated_at, id],
    )?;
    Ok(())
}

pub fn insert_transcript_segment(
    conn: &Connection,
    segment: NewTranscriptSegment,
) -> Result<TranscriptSegment> {
    conn.execute(
        "INSERT INTO transcript_segments (
            id, meeting_id, seq, speaker, text, start_ms, end_ms, status, created_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            segment.id,
            segment.meeting_id,
            segment.seq,
            segment.speaker.as_str(),
            segment.text,
            segment.start_ms,
            segment.end_ms,
            segment.status.as_str(),
            segment.created_at
        ],
    )?;

    Ok(TranscriptSegment {
        id: segment.id,
        meeting_id: segment.meeting_id,
        seq: segment.seq,
        speaker: segment.speaker,
        text: segment.text,
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        status: segment.status,
        created_at: segment.created_at,
    })
}

pub fn select_transcript_segments(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<TranscriptSegment>> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, seq, speaker, text, start_ms, end_ms, status, created_at
         FROM transcript_segments
         WHERE meeting_id = ?1
         ORDER BY seq ASC",
    )?;

    stmt.query_map(params![meeting_id], row_to_segment)?
        .collect::<Result<Vec<_>>>()
}

fn row_to_meeting(row: &rusqlite::Row<'_>) -> Result<Meeting> {
    let status: String = row.get(5)?;
    Ok(Meeting {
        id: row.get(0)?,
        title: row.get(1)?,
        source_app: row.get(2)?,
        started_at: row.get(3)?,
        ended_at: row.get(4)?,
        status: MeetingStatus::try_from(status.as_str()).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, err)),
            )
        })?,
        template_id: row.get(6)?,
        routed_skill_slug: row.get(7)?,
        agent_conversation_id: row.get(8)?,
        notes_markdown: row.get(9)?,
        notes_struct_json: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn row_to_segment(row: &rusqlite::Row<'_>) -> Result<TranscriptSegment> {
    let speaker: String = row.get(3)?;
    let status: String = row.get(7)?;
    Ok(TranscriptSegment {
        id: row.get(0)?,
        meeting_id: row.get(1)?,
        seq: row.get(2)?,
        speaker: Speaker::try_from(speaker.as_str()).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, err)),
            )
        })?,
        text: row.get(4)?,
        start_ms: row.get(5)?,
        end_ms: row.get(6)?,
        status: SegmentStatus::try_from(status.as_str()).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, err)),
            )
        })?,
        created_at: row.get(8)?,
    })
}

async fn run_db<T>(
    app: AppHandle,
    f: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let pool = app.state::<DbPool>();
        pool.with_connection(f)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::setup_schema;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    fn meeting(id: &str) -> NewMeeting {
        NewMeeting {
            id: id.to_string(),
            title: "Customer discovery".to_string(),
            source_app: Some("Zoom".to_string()),
            started_at: 10,
            template_id: Some("discovery".to_string()),
            now: 20,
        }
    }

    #[test]
    fn meeting_persistence_round_trips_status_and_fields() {
        let conn = setup();

        let created = insert_meeting(&conn, meeting("meeting-1")).unwrap();
        update_meeting_status_record(&conn, "meeting-1", MeetingStatus::Done, Some(100), 101)
            .unwrap();
        let loaded = select_meeting(&conn, "meeting-1").unwrap().unwrap();

        assert_eq!(created.status, MeetingStatus::Capturing);
        assert_eq!(loaded.status, MeetingStatus::Done);
        assert_eq!(loaded.ended_at, Some(100));
        assert_eq!(loaded.title, "Customer discovery");
        assert_eq!(loaded.source_app.as_deref(), Some("Zoom"));
        assert_eq!(loaded.template_id.as_deref(), Some("discovery"));
    }

    #[test]
    fn transcript_segments_round_trip_ordered_by_seq() {
        let conn = setup();
        insert_meeting(&conn, meeting("meeting-1")).unwrap();

        for seq in [2, 0, 1] {
            insert_transcript_segment(
                &conn,
                NewTranscriptSegment {
                    id: format!("segment-{}", seq),
                    meeting_id: "meeting-1".to_string(),
                    seq,
                    speaker: if seq == 1 { Speaker::Them } else { Speaker::Me },
                    text: format!("text {}", seq),
                    start_ms: seq * 100,
                    end_ms: seq * 100 + 50,
                    status: if seq == 2 {
                        SegmentStatus::Gap
                    } else {
                        SegmentStatus::Ok
                    },
                    created_at: 30 + seq,
                },
            )
            .unwrap();
        }

        let segments = select_transcript_segments(&conn, "meeting-1").unwrap();

        assert_eq!(
            segments
                .iter()
                .map(|segment| segment.seq)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(segments[1].speaker, Speaker::Them);
        assert_eq!(segments[2].status, SegmentStatus::Gap);
    }

    #[test]
    fn rerunning_schema_setup_preserves_existing_meeting_data() {
        let conn = setup();
        insert_meeting(&conn, meeting("meeting-1")).unwrap();
        insert_transcript_segment(
            &conn,
            NewTranscriptSegment {
                id: "segment-1".to_string(),
                meeting_id: "meeting-1".to_string(),
                seq: 0,
                speaker: Speaker::Me,
                text: "hello".to_string(),
                start_ms: 0,
                end_ms: 100,
                status: SegmentStatus::Ok,
                created_at: 1,
            },
        )
        .unwrap();

        // Simulate updating an app with a pre-existing chat.db: schema setup runs
        // again at startup. CREATE TABLE IF NOT EXISTS must not drop prior data.
        setup_schema(&conn).unwrap();

        assert!(select_meeting(&conn, "meeting-1").unwrap().is_some());
        let segments = select_transcript_segments(&conn, "meeting-1").unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "hello");
    }
}
