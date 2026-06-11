// ABOUTME: Tauri commands for Meeting Mode persistence and transcript history.
// ABOUTME: Stores meetings and transcript segments without persisting raw audio.

use crate::audio::capture::to_mono_16k;
use crate::audio::chunker::{Chunk, ChunkCfg, chunk as chunk_pcm};
use crate::audio::cleanup::{build_cleanup_prompt, build_transform_prompt};
use crate::audio::detect::{MeetingAutodetectResult, meeting_detection, probe_audio_activity};
use crate::audio::llm::{CompletionRequest, complete};
use crate::audio::merge::merge_segments;
use crate::audio::notes::{ParsedNotes, generate_notes};
use crate::audio::pipeline::{CaptureRegistry, CaptureStopSummary};
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
use crate::services::database::{DbPool, enqueue_sync_tombstone, mark_sync_upsert};
use rusqlite::{Connection, OptionalExtension, Result, params};
use serde::Serialize;
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
pub async fn delete_meeting(app: AppHandle, id: String) -> Result<(), String> {
    let deleted_id = id.clone();
    run_db(app.clone(), move |conn| {
        delete_meeting_record(conn, &id)?;
        Ok(())
    })
    .await?;
    let _ = app.emit(
        "meeting://deleted",
        serde_json::json!({ "meetingId": deleted_id }),
    );
    Ok(())
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
         SET notes_markdown = ?1,
             notes_struct_json = ?2,
             status = ?3,
             failure_reason = NULL,
             updated_at = ?4
         WHERE id = ?5",
        params![
            markdown,
            struct_json,
            MeetingStatus::NotesReady.as_str(),
            now_ms(),
            id
        ],
    )?;
    mark_sync_upsert(conn, "meetings", id)?;
    Ok(())
}

fn set_meeting_seren_notes_id_record(
    conn: &Connection,
    id: &str,
    seren_notes_id: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE meetings
         SET seren_notes_id = ?1,
             updated_at = ?2
         WHERE id = ?3",
        params![seren_notes_id, now_ms(), id],
    )?;
    mark_sync_upsert(conn, "meetings", id)?;
    Ok(())
}

// Tracks meetings that have a publish task in flight so a Regenerate
// triggered before the first publish lands cannot interleave: a second
// publish racing the first would write its id, then the first would
// overwrite with a different (now-stale) id pointing at orphaned content.
// Per-meeting serialization — short-lived; drops on task end via PublishGuard.
fn publishing_meetings() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    SET.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

struct PublishGuard(String);

impl Drop for PublishGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = publishing_meetings().lock() {
            set.remove(&self.0);
        }
    }
}

/// Try to claim the publish slot for a meeting id. Returns the guard on
/// success; None if a publish is already in flight for the same id.
fn claim_publish_slot(meeting_id: &str) -> Option<PublishGuard> {
    let mut set = publishing_meetings().lock().ok()?;
    if !set.insert(meeting_id.to_string()) {
        return None;
    }
    Some(PublishGuard(meeting_id.to_string()))
}

// Body bodies can be megabytes; cap before they ride into telemetry.
const PUBLISH_FAIL_BODY_LIMIT: usize = 2_048;

// Emit a structured "publish failed" event the frontend listens for to call
// captureSupportError, which opens a serenorg/seren-desktop bug ticket from
// the existing support telemetry pipeline. #2343.
fn emit_notes_publish_failed(
    app: &AppHandle,
    meeting_id: &str,
    status: Option<u16>,
    body: &str,
) {
    let trimmed = if body.len() > PUBLISH_FAIL_BODY_LIMIT {
        &body[..PUBLISH_FAIL_BODY_LIMIT]
    } else {
        body
    };
    if let Err(err) = app.emit(
        "meeting://notes-publish-failed",
        serde_json::json!({
            "meetingId": meeting_id,
            "status": status,
            "body": trimmed,
        }),
    ) {
        log::warn!("[meeting] emit notes-publish-failed for {meeting_id}: {err}");
    }
}

// Auto-publish the finalized meeting (notes + action items + transcript) to
// seren-notes so the UI can render a "Chat with meeting notes" link. Runs in
// its own task so a slow gateway never blocks notes-ready from rendering.
// Always re-publishes — a Regenerate-after-publish overwrites the link to
// point at the new content. Skips silently when the user isn't signed in;
// the local UI shows the login CTA based on authStore.
//
// Emits `meeting://notes-publish-failed` (status + body) on a terminal
// failure so the frontend can route it through captureSupportError and open
// a bug ticket automatically. #2343.
async fn spawn_seren_notes_publish(
    app: AppHandle,
    meeting_id: String,
    notes_markdown: String,
    action_items: Vec<String>,
    transcript: String,
) {
    let _slot = match claim_publish_slot(&meeting_id) {
        Some(slot) => slot,
        None => return,
    };
    let lookup_id = meeting_id.clone();
    let meeting = match run_db(app.clone(), move |conn| select_meeting(conn, &lookup_id)).await {
        Ok(Some(m)) => m,
        Ok(None) => return,
        Err(err) => {
            log::warn!(
                "[meeting] seren-notes publish skipped for {}: select_meeting failed: {}",
                meeting_id,
                err
            );
            return;
        }
    };
    let content = crate::audio::seren_notes_publish::build_publish_content(
        &notes_markdown,
        &action_items,
        &transcript,
    );
    let note_id = match crate::audio::seren_notes_publish::publish_meeting_notes(
        &app,
        &meeting.title,
        &content,
    )
    .await
    {
        Ok(id) => id,
        Err(crate::audio::seren_notes_publish::PublishError::NotAuthenticated) => {
            // UI surfaces this via the existing "Login to SerenDB" CTA.
            log::info!(
                "[meeting] seren-notes publish skipped for {} (not authenticated)",
                meeting_id
            );
            return;
        }
        Err(crate::audio::seren_notes_publish::PublishError::Server { status, body }) => {
            log::warn!(
                "[meeting] seren-notes publish failed for {} with {status} after retries",
                meeting_id
            );
            emit_notes_publish_failed(&app, &meeting_id, Some(status), &body);
            return;
        }
        Err(crate::audio::seren_notes_publish::PublishError::Other(msg)) => {
            log::warn!(
                "[meeting] seren-notes publish failed for {}: {}",
                meeting_id,
                msg
            );
            emit_notes_publish_failed(&app, &meeting_id, None, &msg);
            return;
        }
    };
    let store_id = meeting_id.clone();
    let stored_note_id = note_id.clone();
    if let Err(err) = run_db(app.clone(), move |conn| {
        set_meeting_seren_notes_id_record(conn, &store_id, &stored_note_id)
    })
    .await
    {
        log::warn!(
            "[meeting] persist seren-notes id failed for {}: {}",
            meeting_id,
            err
        );
        return;
    }
    emit_meeting_status_by_id(&app, &meeting_id).await;
    if let Err(err) = app.emit(
        "meeting://notes-published",
        serde_json::json!({
            "meetingId": meeting_id,
            "serenNotesId": note_id,
        }),
    ) {
        log::warn!(
            "[meeting] emit meeting://notes-published failed for {}: {}",
            meeting_id,
            err
        );
    }
}

// User-triggered republish: re-runs the same publish path the auto-flow
// uses when notes finalize. Idempotent under PublishGuard — if a publish is
// already in flight for this meeting, the spawned call no-ops without
// double-posting. The frontend `Publish to Seren Notes` button calls this
// after a 5xx-after-retry left the meeting without a `seren_notes_id`. #2343.
#[tauri::command]
pub async fn republish_meeting_to_seren_notes(
    app: AppHandle,
    meeting_id: String,
) -> Result<(), String> {
    let lookup = meeting_id.clone();
    let meeting = run_db(app.clone(), move |conn| select_meeting(conn, &lookup))
        .await?
        .ok_or_else(|| "meeting not found".to_string())?;
    if meeting.notes_markdown.is_none() {
        return Err("meeting has no notes yet".to_string());
    }
    let notes_markdown = meeting.notes_markdown.clone().unwrap_or_default();
    let action_items: Vec<String> = meeting
        .notes_struct_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|v| {
            v.get("action_items")
                .or_else(|| v.get("actionItems"))
                .cloned()
        })
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();
    let transcript_app = app.clone();
    let transcript_id = meeting_id.clone();
    let segments = run_db(transcript_app, move |conn| {
        select_transcript_segments(conn, &transcript_id)
    })
    .await?;
    let transcript = assemble_transcript(segments);
    tauri::async_runtime::spawn(async move {
        spawn_seren_notes_publish(
            app,
            meeting_id,
            notes_markdown,
            action_items,
            transcript,
        )
        .await;
    });
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
        mark_sync_upsert(conn, "meetings", &id)?;
        Ok(())
    })
    .await?;
    emit_meeting_status_by_id(&app, &lookup).await;
    Ok(())
}

#[tauri::command]
pub async fn update_meeting_title(
    app: AppHandle,
    id: String,
    title: String,
) -> Result<(), String> {
    let lookup = id.clone();
    run_db(app.clone(), move |conn| {
        conn.execute(
            "UPDATE meetings
             SET title = ?1, updated_at = ?2
             WHERE id = ?3",
            params![title, now_ms(), id],
        )?;
        mark_sync_upsert(conn, "meetings", &id)?;
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
    let registry_for_start = registry.clone();
    let app_for_start = app.clone();
    let id_for_start = meeting_id.clone();
    let started = tauri::async_runtime::spawn_blocking(move || {
        registry_for_start.start(&app_for_start, &id_for_start)
    })
    .await
    .map_err(|err| err.to_string())?;
    match started {
        Ok(()) => {
            let diagnostics = capture_start_diagnostics_json(true, None);
            let id = meeting_id.clone();
            let update = run_db(app.clone(), move |conn| {
                update_meeting_status_record_with_failure_reason_and_diagnostics(
                    conn,
                    &id,
                    MeetingStatus::Capturing,
                    None,
                    None,
                    Some(&diagnostics),
                    now_ms(),
                )
            })
            .await;
            if let Err(err) = update {
                let _ = registry.stop(&meeting_id).await;
                return Err(err);
            }
            emit_meeting_status_by_id(&app, &meeting_id).await;
            Ok(())
        }
        Err(reason) => {
            let ended = now_ms();
            let diagnostics = capture_start_diagnostics_json(false, Some(&reason));
            let id = meeting_id.clone();
            let reason_for_db = reason.clone();
            run_db(app.clone(), move |conn| {
                update_meeting_status_record_with_failure_reason_and_diagnostics(
                    conn,
                    &id,
                    MeetingStatus::Failed,
                    Some(ended),
                    Some(&reason_for_db),
                    Some(&diagnostics),
                    ended,
                )
            })
            .await?;
            emit_meeting_status_by_id(&app, &meeting_id).await;
            Err(reason)
        }
    }
}

#[tauri::command]
pub fn is_meeting_capture_active(registry: State<'_, CaptureRegistry>, meeting_id: String) -> bool {
    registry.is_active(&meeting_id)
}

#[tauri::command]
pub async fn stop_meeting_capture(
    app: AppHandle,
    registry: State<'_, CaptureRegistry>,
    meeting_id: String,
) -> Result<StopMeetingCaptureOutcome, String> {
    let summary = registry.stop(&meeting_id).await;
    let ended = now_ms();
    let lookup = meeting_id.clone();
    let segments = run_db(app.clone(), move |conn| {
        select_transcript_segments(conn, &lookup)
    })
    .await?;
    let persisted_segment_count = segments.len() as u64;
    let persisted_text_segment_count = segments
        .iter()
        .filter(|segment| segment.status == SegmentStatus::Ok && !segment.text.trim().is_empty())
        .count() as u64;
    let existing_lookup = meeting_id.clone();
    let existing = run_db(app.clone(), move |conn| {
        select_meeting(conn, &existing_lookup)
    })
    .await?;
    let preserve_existing_failure = !summary.had_capture
        && existing
            .as_ref()
            .is_some_and(|meeting| meeting.status == MeetingStatus::Failed);
    let failure_reason = if preserve_existing_failure {
        existing.and_then(|meeting| meeting.failure_reason)
    } else {
        stop_capture_failure_reason(
            &summary,
            persisted_segment_count,
            persisted_text_segment_count,
        )
    };
    let capture_diagnostics_json = capture_stop_diagnostics_json(
        &summary,
        persisted_segment_count,
        persisted_text_segment_count,
        failure_reason.as_deref(),
    );

    let outcome = StopMeetingCaptureOutcome {
        had_capture: summary.had_capture,
        native_mic_ready: summary.native_mic_ready,
        system_audio_ready: summary.system_audio_ready,
        apm_ready: summary.apm_ready,
        apm_active: summary.apm_active,
        native_mic_frame_count: summary.native_mic_frame_count,
        system_audio_frame_count: summary.system_audio_frame_count,
        level_event_count: summary.level_event_count,
        push_frame_count: summary.push_frame_count,
        accepted_push_frame_count: summary.accepted_push_frame_count,
        dropped_push_frame_count: summary.dropped_push_frame_count,
        dropped_push_sample_count: summary.dropped_push_sample_count,
        frame_count: summary.frame_count,
        sample_count: summary.sample_count,
        speech_frame_count: summary.speech_frame_count,
        chunk_count: summary.chunk_count,
        emitted_segment_count: summary.emitted_segment_count,
        emitted_gap_count: summary.emitted_gap_count,
        persisted_segment_count,
        persisted_text_segment_count,
        apm: summary.apm.clone(),
        capture_diagnostics_json: capture_diagnostics_json.clone(),
        failure_reason: failure_reason.clone(),
    };
    if preserve_existing_failure {
        return Ok(outcome);
    }

    let status = if failure_reason.is_some() {
        MeetingStatus::Failed
    } else {
        MeetingStatus::Transcribing
    };
    let id = meeting_id.clone();
    let reason = failure_reason.clone();
    run_db(app.clone(), move |conn| {
        update_meeting_status_record_with_failure_reason_and_diagnostics(
            conn,
            &id,
            status,
            Some(ended),
            reason.as_deref(),
            Some(&capture_diagnostics_json),
            ended,
        )
    })
    .await?;
    emit_meeting_status_by_id(&app, &meeting_id).await;
    Ok(outcome)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopMeetingCaptureOutcome {
    pub had_capture: bool,
    pub native_mic_ready: bool,
    pub system_audio_ready: bool,
    pub apm_ready: bool,
    pub apm_active: bool,
    pub native_mic_frame_count: u64,
    pub system_audio_frame_count: u64,
    pub level_event_count: u64,
    pub push_frame_count: u64,
    pub accepted_push_frame_count: u64,
    pub dropped_push_frame_count: u64,
    pub dropped_push_sample_count: u64,
    pub frame_count: u64,
    pub sample_count: u64,
    pub speech_frame_count: u64,
    pub chunk_count: u64,
    pub emitted_segment_count: u64,
    pub emitted_gap_count: u64,
    pub persisted_segment_count: u64,
    pub persisted_text_segment_count: u64,
    pub apm: crate::audio::apm::ApmDiagnostics,
    pub capture_diagnostics_json: String,
    pub failure_reason: Option<String>,
}

fn capture_start_diagnostics_json(started: bool, error: Option<&str>) -> String {
    serde_json::json!({
        "schema": "meeting_capture_v2",
        "phase": if started { "started" } else { "start_failed" },
        "backend": "native_rust",
        "rendererPushPath": "disabled",
        "nativeMicRequired": true,
        "apmRequired": true,
        "error": error,
        "updatedAt": now_ms(),
    })
    .to_string()
}

fn capture_stop_diagnostics_json(
    summary: &CaptureStopSummary,
    persisted_segment_count: u64,
    persisted_text_segment_count: u64,
    failure_reason: Option<&str>,
) -> String {
    serde_json::json!({
        "schema": "meeting_capture_v2",
        "phase": "stopped",
        "backend": "native_rust",
        "rendererPushPath": "disabled",
        "hadCapture": summary.had_capture,
        "nativeMicReady": summary.native_mic_ready,
        "systemAudioReady": summary.system_audio_ready,
        "apmReady": summary.apm_ready,
        "apmActive": summary.apm_active,
        "nativeMicFrameCount": summary.native_mic_frame_count,
        "systemAudioFrameCount": summary.system_audio_frame_count,
        "levelEventCount": summary.level_event_count,
        "pushFrameCount": summary.push_frame_count,
        "acceptedPushFrameCount": summary.accepted_push_frame_count,
        "droppedPushFrameCount": summary.dropped_push_frame_count,
        "droppedPushSampleCount": summary.dropped_push_sample_count,
        "frameCount": summary.frame_count,
        "sampleCount": summary.sample_count,
        "speechFrameCount": summary.speech_frame_count,
        "chunkCount": summary.chunk_count,
        "emittedSegmentCount": summary.emitted_segment_count,
        "emittedGapCount": summary.emitted_gap_count,
        "persistedSegmentCount": persisted_segment_count,
        "persistedTextSegmentCount": persisted_text_segment_count,
        "failureReason": failure_reason,
        "apm": summary.apm,
        "updatedAt": now_ms(),
    })
    .to_string()
}

fn stop_capture_failure_reason(
    summary: &CaptureStopSummary,
    persisted_segment_count: u64,
    persisted_text_segment_count: u64,
) -> Option<String> {
    if persisted_text_segment_count > 0 {
        return None;
    }
    if !summary.had_capture {
        if summary.dropped_push_frame_count > 0 {
            return Some(
                "Audio frames reached Seren, but Meeting capture had no active stream to accept them. Restart capture; if it repeats, send logs with the dropped-frame counters."
                    .to_string(),
            );
        }
        return Some(
            "Meeting capture was no longer active when Stop was pressed. Restart Seren and start capture again."
                .to_string(),
        );
    }
    if summary.frame_count == 0 {
        if summary.accepted_push_frame_count > 0 {
            return Some(
                "Audio frames reached Meeting capture, but the transcription worker did not process them. Restart capture; if it repeats, send logs with the accepted-frame counters."
                    .to_string(),
            );
        }
        if summary.dropped_push_frame_count > 0 {
            return Some(
                "Audio frames reached Seren, but were dropped before transcription. Restart capture; if it repeats, send logs with the dropped-frame counters."
                    .to_string(),
            );
        }
        return Some(
            "No audio reached Meeting capture. Check microphone and system-audio permissions, then start capture again."
                .to_string(),
        );
    }
    if summary.speech_frame_count == 0 {
        return Some(
            "Audio reached Meeting capture, but no speech was detected. Check the selected microphone and system-audio source, then start capture again."
                .to_string(),
        );
    }
    if summary.chunk_count == 0 {
        return Some(
            "Audio reached Meeting capture, but it was too short or quiet to transcribe. Speak for a few seconds, then start capture again."
                .to_string(),
        );
    }
    if persisted_segment_count == 0 {
        return Some(
            "Audio reached transcription, but no transcript segments were saved. Check network and speech-to-text service connectivity, then start capture again."
                .to_string(),
        );
    }
    Some(
        "Audio reached transcription, but no words were transcribed. Check input levels and try capture again."
            .to_string(),
    )
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

    // Fire-and-forget seren-notes auto-publish so the UI gets a
    // "Chat with meeting notes" link without blocking notes-ready render.
    let publish_app = app.clone();
    let publish_id = lookup.clone();
    let publish_markdown = parsed.markdown.clone();
    let publish_action_items = parsed.structured.action_items.clone();
    let publish_transcript = transcript.clone();
    tauri::async_runtime::spawn(async move {
        spawn_seren_notes_publish(
            publish_app,
            publish_id,
            publish_markdown,
            publish_action_items,
            publish_transcript,
        )
        .await;
    });

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
pub fn meeting_autodetect() -> MeetingAutodetectResult {
    let activity = probe_audio_activity();
    meeting_detection(activity)
}

// --- Dictation (shares the transcribe + cleanup engines with Meeting Mode) --

/// Transcribe a single dictation chunk; returns "" for silence rather than erroring.
///
/// VAD-gated (#2349): silent buffers never reach whisper-1, which hallucinates
/// Korean MBC news sign-offs and "Thank you." on non-speech audio. Reuses the
/// Meeting-Mode chunker so dictation and meeting share one tested speech filter.
#[tauri::command]
pub async fn transcribe_pcm(
    app: AppHandle,
    samples: Vec<i16>,
    channels: u16,
    sample_rate: u32,
) -> Result<String, String> {
    let normalized = to_mono_16k(&samples, channels.max(1), sample_rate);
    let Some(speech) = extract_dictation_speech(normalized) else {
        return Ok(String::new());
    };
    let chunk = Chunk {
        start_ms: 0,
        end_ms: 0,
        samples: speech,
    };
    let transcriber = GatewayTranscriber::new(app);
    let cfg = RetryConfig {
        retry_on_empty: false,
        ..RetryConfig::default()
    };
    match transcribe_chunk_with_retry(&transcriber, &chunk, cfg).await {
        Ok(segments) => Ok(segments
            .into_iter()
            .map(|segment| segment.text)
            .collect::<Vec<_>>()
            .join(" ")),
        Err(TranscribeError::Empty) => Ok(String::new()),
        Err(err) => Err(err.to_string()),
    }
}

/// VAD-filter dictation PCM: returns `None` when no speech is detected, else the
/// concatenated speech samples (trimmed silence at the edges and between turns).
///
/// Shares the Meeting-Mode energy threshold and silence cutoff. `min_window_ms`
/// is lowered to 100 ms so single-syllable dictation words ("Hi", "no") still
/// pass the gate — Meeting Mode's 250 ms default is tuned for full utterances.
fn extract_dictation_speech(samples: Vec<i16>) -> Option<Vec<i16>> {
    if samples.is_empty() {
        return None;
    }
    let cfg = ChunkCfg {
        min_window_ms: 100,
        ..ChunkCfg::default()
    };
    let chunks = chunk_pcm(&samples, cfg);
    if chunks.is_empty() {
        return None;
    }
    let total: usize = chunks.iter().map(|chunk| chunk.samples.len()).sum();
    let mut speech = Vec::with_capacity(total);
    for chunk in chunks {
        speech.extend(chunk.samples);
    }
    Some(speech)
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
            notes_struct_json, failure_reason, capture_diagnostics_json,
            seren_notes_id, created_at, updated_at
         )
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?7, ?7)",
        params![
            meeting.id,
            meeting.title,
            meeting.source_app,
            meeting.started_at,
            MeetingStatus::PendingCapture.as_str(),
            meeting.template_id,
            meeting.now
        ],
    )?;
    mark_sync_upsert(conn, "meetings", &meeting.id)?;

    select_meeting(conn, &meeting.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn select_meeting(conn: &Connection, id: &str) -> Result<Option<Meeting>> {
    conn.query_row(
        "SELECT id, title, source_app, started_at, ended_at, status, template_id,
                routed_skill_slug, agent_conversation_id, notes_markdown,
                notes_struct_json, failure_reason, capture_diagnostics_json,
                seren_notes_id, created_at, updated_at
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
                notes_struct_json, failure_reason, capture_diagnostics_json,
                seren_notes_id, created_at, updated_at
         FROM meetings
         ORDER BY started_at DESC
         LIMIT ?1",
    )?;

    stmt.query_map(params![limit], row_to_meeting)?
        .collect::<Result<Vec<_>>>()
}

pub fn delete_meeting_record(conn: &Connection, id: &str) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut stmt = tx.prepare("SELECT id FROM transcript_segments WHERE meeting_id = ?1")?;
    let segment_ids = stmt
        .query_map(params![id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for segment_id in &segment_ids {
        enqueue_sync_tombstone(&tx, "transcript_segments", segment_id)?;
    }
    enqueue_sync_tombstone(&tx, "meetings", id)?;
    tx.execute(
        "DELETE FROM transcript_segments WHERE meeting_id = ?1",
        params![id],
    )?;
    let deleted = tx.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(deleted)
}

pub fn update_meeting_status_record(
    conn: &Connection,
    id: &str,
    status: MeetingStatus,
    ended_at: Option<i64>,
    updated_at: i64,
) -> Result<()> {
    update_meeting_status_record_with_failure_reason_and_diagnostics(
        conn, id, status, ended_at, None, None, updated_at,
    )
}

pub fn update_meeting_status_record_with_failure_reason(
    conn: &Connection,
    id: &str,
    status: MeetingStatus,
    ended_at: Option<i64>,
    failure_reason: Option<&str>,
    updated_at: i64,
) -> Result<()> {
    update_meeting_status_record_with_failure_reason_and_diagnostics(
        conn,
        id,
        status,
        ended_at,
        failure_reason,
        None,
        updated_at,
    )
}

pub fn update_meeting_status_record_with_failure_reason_and_diagnostics(
    conn: &Connection,
    id: &str,
    status: MeetingStatus,
    ended_at: Option<i64>,
    failure_reason: Option<&str>,
    capture_diagnostics_json: Option<&str>,
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
             failure_reason = CASE WHEN ?1 IN ('failed', 'transcript_ready') THEN ?3 ELSE NULL END,
             capture_diagnostics_json = COALESCE(?4, capture_diagnostics_json),
             updated_at = ?5
         WHERE id = ?6",
        params![
            status.as_str(),
            ended_at,
            failure_reason,
            capture_diagnostics_json,
            updated_at,
            id
        ],
    )?;
    mark_sync_upsert(conn, "meetings", id)?;
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
    mark_sync_upsert(conn, "transcript_segments", &segment.id)?;

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
    mark_sync_upsert(conn, "transcript_segments", id)?;
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
        capture_diagnostics_json: row.get(12)?,
        seren_notes_id: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
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

    #[test]
    fn publish_slot_blocks_overlapping_claims_for_same_meeting() {
        let slot = claim_publish_slot("meeting-publish-slot-a").expect("first claim");
        assert!(
            claim_publish_slot("meeting-publish-slot-a").is_none(),
            "second claim for the same meeting must fail while the first guard lives"
        );
        let other = claim_publish_slot("meeting-publish-slot-b").expect("other meeting still free");
        drop(other);
        drop(slot);
        assert!(
            claim_publish_slot("meeting-publish-slot-a").is_some(),
            "claim succeeds again after the guard drops — regenerate can re-publish"
        );
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

        assert_eq!(created.status, MeetingStatus::PendingCapture);
        assert_eq!(loaded.status, MeetingStatus::Done);
        assert_eq!(loaded.ended_at, Some(100));
        assert_eq!(loaded.title, "Customer discovery");
        assert_eq!(loaded.source_app.as_deref(), Some("Zoom"));
        assert_eq!(loaded.template_id.as_deref(), Some("discovery"));
        assert_eq!(loaded.failure_reason, None);
        assert_eq!(loaded.capture_diagnostics_json, None);
    }

    #[test]
    fn status_update_preserves_ended_at_unless_overwritten() {
        // #2174: ended_at is stamped once at capture stop; status-only transitions
        // (None) must preserve it; a Some value still overwrites.
        let conn = setup();
        insert_meeting(&conn, meeting("meeting-1")).unwrap();

        // Capture stops: ended_at set.
        update_meeting_status_record_with_failure_reason_and_diagnostics(
            &conn,
            "meeting-1",
            MeetingStatus::Transcribing,
            Some(500),
            None,
            Some("{\"phase\":\"stopped\"}"),
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
                .capture_diagnostics_json
                .as_deref(),
            Some("{\"phase\":\"stopped\"}")
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
        assert_eq!(
            failed.capture_diagnostics_json.as_deref(),
            Some("{\"phase\":\"stopped\"}")
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
    fn delete_meeting_record_removes_notes_and_transcript_segments() {
        let conn = setup();
        insert_meeting(&conn, meeting("meeting-1")).unwrap();
        set_meeting_notes_record(&conn, "meeting-1", "notes", "{}").unwrap();
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
                created_at: 30,
            },
        )
        .unwrap();

        assert_eq!(delete_meeting_record(&conn, "meeting-1").unwrap(), 1);
        assert!(select_meeting(&conn, "meeting-1").unwrap().is_none());
        assert!(
            select_transcript_segments(&conn, "meeting-1")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn stop_capture_failure_reason_describes_no_audio_frames() {
        let summary = crate::audio::pipeline::CaptureStopSummary {
            had_capture: true,
            frame_count: 0,
            sample_count: 0,
            speech_frame_count: 0,
            chunk_count: 0,
            emitted_segment_count: 0,
            emitted_gap_count: 0,
            ..Default::default()
        };

        let reason = stop_capture_failure_reason(&summary, 0, 0).unwrap();

        assert!(reason.contains("No audio reached Meeting capture"));
    }

    #[test]
    fn stop_capture_failure_reason_describes_dropped_capture_frames() {
        let summary = crate::audio::pipeline::CaptureStopSummary {
            had_capture: true,
            push_frame_count: 1,
            dropped_push_frame_count: 1,
            dropped_push_sample_count: 128,
            ..Default::default()
        };

        let reason = stop_capture_failure_reason(&summary, 0, 0).unwrap();

        assert!(reason.contains("dropped before transcription"));
    }

    #[test]
    fn stop_capture_failure_reason_describes_unprocessed_accepted_frames() {
        let summary = crate::audio::pipeline::CaptureStopSummary {
            had_capture: true,
            push_frame_count: 1,
            accepted_push_frame_count: 1,
            ..Default::default()
        };

        let reason = stop_capture_failure_reason(&summary, 0, 0).unwrap();

        assert!(reason.contains("transcription worker did not process"));
    }

    #[test]
    fn stop_capture_failure_reason_describes_unpersisted_transcript_output() {
        let summary = crate::audio::pipeline::CaptureStopSummary {
            had_capture: true,
            frame_count: 12,
            sample_count: 3_840,
            speech_frame_count: 6,
            chunk_count: 1,
            emitted_segment_count: 1,
            emitted_gap_count: 0,
            ..Default::default()
        };

        let reason = stop_capture_failure_reason(&summary, 0, 0).unwrap();

        assert!(reason.contains("reached transcription"));
    }

    #[test]
    fn stop_capture_failure_reason_allows_persisted_transcript_text() {
        let summary = crate::audio::pipeline::CaptureStopSummary {
            had_capture: true,
            frame_count: 12,
            sample_count: 3_840,
            speech_frame_count: 6,
            chunk_count: 1,
            emitted_segment_count: 1,
            emitted_gap_count: 0,
            ..Default::default()
        };

        assert_eq!(stop_capture_failure_reason(&summary, 1, 1), None);
    }

    #[test]
    fn dictation_vad_gate_drops_pure_silence_before_whisper() {
        // #2349: silent dictation buffers must not reach whisper-1, which
        // hallucinates Korean MBC sign-offs ("MBC 뉴스 …입니다") and "Thank you."
        // on non-speech audio. The gate is the same VAD Meeting Mode runs.
        // 1s @ 16kHz of dead silence — what a near-mute mic produces between
        // partial flushes.
        let silence = vec![0i16; 16_000];

        assert!(extract_dictation_speech(silence).is_none());
    }

    #[test]
    fn dictation_vad_gate_preserves_speech_samples() {
        // A buffer with real signal above the VAD threshold must pass through.
        // ~1.5s @ 16kHz of square-wave PCM (well above the 350 RMS threshold) —
        // matches a normal dictation flush window.
        let speech: Vec<i16> = (0..24_000)
            .map(|i| if i % 16 < 8 { 8_000 } else { -8_000 })
            .collect();

        let extracted = extract_dictation_speech(speech).expect("speech must pass the gate");
        assert!(
            !extracted.is_empty(),
            "speech samples must survive the VAD gate"
        );
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
