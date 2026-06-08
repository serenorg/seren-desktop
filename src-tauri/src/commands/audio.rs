// ABOUTME: Tauri commands for Meeting Mode persistence and transcript history.
// ABOUTME: Stores meetings and transcript segments without persisting raw audio.

use crate::audio::capture::to_mono_16k;
use crate::audio::chunker::Chunk;
use crate::audio::cleanup::{build_cleanup_prompt, build_transform_prompt};
use crate::audio::detect::{probe_audio_activity, should_start_capture};
use crate::audio::llm::{CompletionRequest, complete};
use crate::audio::merge::merge_segments;
use crate::audio::notes::{ParsedNotes, generate_notes};
use crate::audio::pipeline::CaptureRegistry;
use crate::audio::reconcile::reconcile_speaker_labels;
use crate::audio::templates::{BUILT_IN_MEETING_TEMPLATES, MeetingTemplate};
use crate::audio::transcribe::{
    GatewayTranscriber, RetryConfig, TranscribeError, transcribe_chunk_with_retry,
    transcribe_full_recording,
};
use crate::audio::types::{
    Meeting, MeetingStatus, SegmentStatus, Speaker, SpeakerSource, TranscriptSegment,
};
use crate::orchestrator::types::SkillRef;
use crate::services::database::DbPool;
use rusqlite::{Connection, OptionalExtension, Result, params};
use tauri::{AppHandle, Emitter, Manager, State};
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

    let created = run_db(app.clone(), move |conn| insert_meeting(conn, meeting)).await?;
    emit_meeting_status(&app, &created);
    Ok(created)
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
    failure_reason: Option<String>,
) -> Result<(), String> {
    let lookup = id.clone();
    run_db(app.clone(), move |conn| {
        update_meeting_status_record_with_failure_reason(
            conn,
            &id,
            status,
            ended_at,
            failure_reason.as_deref(),
            now_ms(),
        )
    })
    .await?;
    emit_meeting_status_by_id(&app, &lookup).await;
    Ok(())
}

#[tauri::command]
pub async fn update_meeting_notes(
    app: AppHandle,
    id: String,
    notes_markdown: String,
    notes_struct_json: String,
) -> Result<(), String> {
    let lookup = id.clone();
    run_db(app.clone(), move |conn| {
        set_meeting_notes_record(conn, &id, &notes_markdown, &notes_struct_json)
    })
    .await?;
    emit_meeting_status_by_id(&app, &lookup).await;
    Ok(())
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
    let lookup = id.clone();
    run_db(app.clone(), move |conn| {
        conn.execute(
            "UPDATE meetings
             SET routed_skill_slug = ?1, agent_conversation_id = ?2, updated_at = ?3
             WHERE id = ?4",
            params![routed_skill_slug, agent_conversation_id, now_ms(), id],
        )?;
        Ok(())
    })
    .await?;
    emit_meeting_status_by_id(&app, &lookup).await;
    Ok(())
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
        // Manual appends carry the channel speaker, not a diarization label.
        speaker_label: None,
        speaker_source: SpeakerSource::Channel,
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
    // start() blocks on native WASAPI/Core Audio init (#2157). Run it on the
    // blocking pool so it never stalls a tokio worker thread; the registry is an
    // Arc handle, so the clone shares the same state (#2176).
    let registry = (*registry).clone();
    tauri::async_runtime::spawn_blocking(move || registry.start(&app, &meeting_id))
        .await
        .map_err(|err| err.to_string())?;
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
    let lookup = meeting_id.clone();
    let id = meeting_id;
    run_db(app.clone(), move |conn| {
        update_meeting_status_record(conn, &id, MeetingStatus::Transcribing, Some(ended), ended)
    })
    .await?;
    emit_meeting_status_by_id(&app, &lookup).await;
    Ok(())
}

/// Post-call diarization refinement: run ONE diarized pass over the full Them
/// recording and stamp its meeting-stable speaker labels onto the live Them
/// segments. The live path diarizes per streaming chunk (#2127), so its labels
/// reset every chunk; one pass over the whole recording keeps a speaker's label
/// stable across the meeting. Returns the count of segments relabeled.
///
/// Best-effort and additive: absent/short audio, a transcription failure, or no
/// overlap returns `Ok(0)` and leaves existing labels untouched — it never
/// corrupts what the live path already produced.
#[tauri::command]
pub async fn reconcile_meeting_speakers(
    app: AppHandle,
    registry: State<'_, CaptureRegistry>,
    meeting_id: String,
) -> Result<usize, String> {
    // Take (and consume) the buffered Them PCM. Too little audio to be worth a
    // diarized pass -> nothing to do.
    let Some(pcm) = registry.take_finished_them_audio(&meeting_id) else {
        return Ok(0);
    };
    // ~30 s of 16 kHz mono. Below this a single short turn gains nothing from a
    // whole-recording pass; skip the cost.
    const MIN_RECONCILE_SAMPLES: usize = crate::audio::capture::TARGET_SAMPLE_RATE as usize * 30;
    if pcm.len() < MIN_RECONCILE_SAMPLES {
        return Ok(0);
    }

    let diarized = match transcribe_full_recording(&app, &pcm).await {
        Ok(segments) => segments,
        Err(err) => {
            log::warn!("[meeting] post-call diarization failed for {meeting_id}: {err}");
            return Ok(0);
        }
    };
    if diarized.is_empty() {
        return Ok(0);
    }

    // Reconcile against only the live Them segments — the Me mic is single-speaker
    // and is never relabeled by this pass.
    let lookup = meeting_id.clone();
    let live_them: Vec<TranscriptSegment> = run_db(app.clone(), move |conn| {
        select_transcript_segments(conn, &lookup)
    })
    .await?
    .into_iter()
    .filter(|segment| segment.speaker == Speaker::Them)
    .collect();
    if live_them.is_empty() {
        return Ok(0);
    }

    let mapping = reconcile_speaker_labels(&live_them, &diarized);
    if mapping.is_empty() {
        return Ok(0);
    }

    let to_apply = mapping.clone();
    let updated = run_db(app.clone(), move |conn| {
        let mut count = 0usize;
        for (id, label) in &to_apply {
            update_transcript_segment_speaker(conn, id, label)?;
            count += 1;
        }
        Ok(count)
    })
    .await?;

    let _ = app.emit(
        "meeting://segments-updated",
        serde_json::json!({ "meetingId": meeting_id }),
    );
    Ok(updated)
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
    let segments = run_db(app.clone(), move |conn| {
        select_transcript_segments(conn, &lookup)
    })
    .await?;
    let transcript = assemble_transcript(segments);
    if transcript.trim().is_empty() {
        return Err("no transcript to summarize".to_string());
    }

    let parsed = generate_notes(&app, model, &transcript, &template_prompt, &vocabulary).await?;
    let struct_json = serde_json::to_string(&parsed.structured).map_err(|err| err.to_string())?;
    let markdown = parsed.markdown.clone();
    let lookup = meeting_id.clone();
    let id = meeting_id;
    run_db(app.clone(), move |conn| {
        set_meeting_notes_record(conn, &id, &markdown, &struct_json)
    })
    .await?;
    emit_meeting_status_by_id(&app, &lookup).await;
    Ok(parsed)
}

#[tauri::command]
pub async fn get_meeting_transcript_text(
    app: AppHandle,
    meeting_id: String,
) -> Result<String, String> {
    let segments = run_db(app, move |conn| {
        select_transcript_segments(conn, &meeting_id)
    })
    .await?;
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

/// Probe audio activity, then decide whether a meeting capture should arm.
/// Process presence alone must not surface a record prompt.
#[tauri::command]
pub fn meeting_autodetect() -> bool {
    let activity = probe_audio_activity();
    should_start_capture(activity)
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
        Ok(segments) => Ok(segments
            .into_iter()
            .map(|segment| segment.text)
            .collect::<Vec<_>>()
            .join(" ")),
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
    pub speaker_label: Option<String>,
    pub speaker_source: SpeakerSource,
    pub created_at: i64,
}

pub fn insert_meeting(conn: &Connection, meeting: NewMeeting) -> Result<Meeting> {
    conn.execute(
        "INSERT INTO meetings (
            id, title, source_app, started_at, ended_at, status, template_id,
            routed_skill_slug, agent_conversation_id, notes_markdown,
            notes_struct_json, failure_reason, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, NULL, NULL, NULL, NULL, NULL, ?7, ?7)",
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
                notes_struct_json, failure_reason, created_at, updated_at
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
                notes_struct_json, failure_reason, created_at, updated_at
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
    update_meeting_status_record_with_failure_reason(conn, id, status, ended_at, None, updated_at)
}

pub fn update_meeting_status_record_with_failure_reason(
    conn: &Connection,
    id: &str,
    status: MeetingStatus,
    ended_at: Option<i64>,
    failure_reason: Option<&str>,
    updated_at: i64,
) -> Result<()> {
    // `ended_at` is set once, when capture stops. COALESCE keeps the existing
    // value when the caller passes None (status-only transitions like
    // agent_running/done), so the capture-end time survives the agent handoff
    // instead of being nulled and later overwritten with the agent-finish time
    // (#2174). A Some value still overwrites (e.g. stop_meeting_capture).
    conn.execute(
        "UPDATE meetings
         SET status = ?1,
             ended_at = COALESCE(?2, ended_at),
             failure_reason = CASE WHEN ?1 = 'failed' THEN ?3 ELSE NULL END,
             updated_at = ?4
         WHERE id = ?5",
        params![status.as_str(), ended_at, failure_reason, updated_at, id],
    )?;
    Ok(())
}

pub fn insert_transcript_segment(
    conn: &Connection,
    segment: NewTranscriptSegment,
) -> Result<TranscriptSegment> {
    conn.execute(
        "INSERT INTO transcript_segments (
            id, meeting_id, seq, speaker, text, start_ms, end_ms, status,
            speaker_label, speaker_source, created_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            segment.id,
            segment.meeting_id,
            segment.seq,
            segment.speaker.as_str(),
            segment.text,
            segment.start_ms,
            segment.end_ms,
            segment.status.as_str(),
            segment.speaker_label,
            segment.speaker_source.as_str(),
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
        speaker_label: segment.speaker_label,
        speaker_source: segment.speaker_source,
        created_at: segment.created_at,
    })
}

pub fn select_transcript_segments(
    conn: &Connection,
    meeting_id: &str,
) -> Result<Vec<TranscriptSegment>> {
    let mut stmt = conn.prepare(
        "SELECT id, meeting_id, seq, speaker, text, start_ms, end_ms, status,
                speaker_label, speaker_source, created_at
         FROM transcript_segments
         WHERE meeting_id = ?1
         ORDER BY seq ASC",
    )?;

    stmt.query_map(params![meeting_id], row_to_segment)?
        .collect::<Result<Vec<_>>>()
}

/// Stamp a meeting-stable diarization label onto one segment. Used by the
/// post-call reconcile pass; only `speaker_label`/`speaker_source` change, so the
/// segment's text, timing, and channel `speaker` (Me/Them) are left intact.
pub fn update_transcript_segment_speaker(conn: &Connection, id: &str, label: &str) -> Result<()> {
    conn.execute(
        "UPDATE transcript_segments
         SET speaker_label = ?1, speaker_source = ?2
         WHERE id = ?3",
        params![label, SpeakerSource::Diarization.as_str(), id],
    )?;
    Ok(())
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
        failure_reason: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn row_to_segment(row: &rusqlite::Row<'_>) -> Result<TranscriptSegment> {
    let speaker: String = row.get(3)?;
    let status: String = row.get(7)?;
    // Legacy rows (pre-diarization) have NULL speaker_source; treat them as channel.
    let speaker_source: Option<String> = row.get(9)?;
    let speaker_source = speaker_source
        .as_deref()
        .map(SpeakerSource::try_from)
        .transpose()
        .map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                9,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, err)),
            )
        })?
        .unwrap_or(SpeakerSource::Channel);
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
        speaker_label: row.get(8)?,
        speaker_source,
        created_at: row.get(10)?,
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

fn emit_meeting_status(app: &AppHandle, meeting: &Meeting) {
    if let Err(err) = app.emit("meeting://status", meeting) {
        log::warn!(
            "[meeting] emit meeting://status failed for {}: {err}",
            meeting.id
        );
    }
}

async fn emit_meeting_status_by_id(app: &AppHandle, meeting_id: &str) {
    let id = meeting_id.to_string();
    let lookup = meeting_id.to_string();
    match run_db(app.clone(), move |conn| select_meeting(conn, &lookup)).await {
        Ok(Some(meeting)) => emit_meeting_status(app, &meeting),
        Ok(None) => log::warn!("[meeting] emit meeting://status skipped, not found: {id}"),
        Err(err) => log::warn!("[meeting] emit meeting://status select failed for {id}: {err}"),
    }
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
        assert_eq!(loaded.failure_reason, None);
    }

    #[test]
    fn status_update_preserves_ended_at_unless_overwritten() {
        // #2174: ended_at is stamped once at capture stop; status-only transitions
        // (None) must preserve it; a Some value still overwrites.
        let conn = setup();
        insert_meeting(&conn, meeting("meeting-1")).unwrap();

        // Capture stops: ended_at set.
        update_meeting_status_record(
            &conn,
            "meeting-1",
            MeetingStatus::Transcribing,
            Some(500),
            501,
        )
        .unwrap();
        // Status-only transition (handoff): None must keep ended_at = 500.
        update_meeting_status_record(&conn, "meeting-1", MeetingStatus::AgentRunning, None, 600)
            .unwrap();
        assert_eq!(
            select_meeting(&conn, "meeting-1")
                .unwrap()
                .unwrap()
                .ended_at,
            Some(500)
        );
        // Done with None still preserves the capture-end time.
        update_meeting_status_record(&conn, "meeting-1", MeetingStatus::Done, None, 700).unwrap();
        assert_eq!(
            select_meeting(&conn, "meeting-1")
                .unwrap()
                .unwrap()
                .ended_at,
            Some(500)
        );
        // A Some value overwrites.
        update_meeting_status_record_with_failure_reason(
            &conn,
            "meeting-1",
            MeetingStatus::Failed,
            Some(900),
            Some("Microphone access is blocked."),
            901,
        )
        .unwrap();
        let failed = select_meeting(&conn, "meeting-1").unwrap().unwrap();
        assert_eq!(failed.ended_at, Some(900));
        assert_eq!(
            failed.failure_reason.as_deref(),
            Some("Microphone access is blocked.")
        );

        update_meeting_status_record(&conn, "meeting-1", MeetingStatus::Done, None, 950).unwrap();
        assert_eq!(
            select_meeting(&conn, "meeting-1")
                .unwrap()
                .unwrap()
                .failure_reason,
            None
        );
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
                    speaker_label: if seq == 1 {
                        Some("A".to_string())
                    } else {
                        None
                    },
                    speaker_source: if seq == 1 {
                        SpeakerSource::Diarization
                    } else {
                        SpeakerSource::Channel
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
        assert_eq!(segments[1].speaker_label.as_deref(), Some("A"));
        assert_eq!(segments[1].speaker_source, SpeakerSource::Diarization);
        assert_eq!(segments[0].speaker_label, None);
        assert_eq!(segments[0].speaker_source, SpeakerSource::Channel);
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
                speaker_label: None,
                speaker_source: SpeakerSource::Channel,
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
