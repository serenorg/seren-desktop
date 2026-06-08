// ABOUTME: Serializable meeting and transcript data shapes shared by Rust IPC.
// ABOUTME: Mirrors the SQLite meeting schema and live transcript events.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Speaker {
    Me,
    Them,
}

impl Speaker {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Me => "me",
            Self::Them => "them",
        }
    }
}

impl TryFrom<&str> for Speaker {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "me" => Ok(Self::Me),
            "them" => Ok(Self::Them),
            _ => Err(format!("Unknown transcript speaker: {}", value)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetingStatus {
    Capturing,
    Transcribing,
    NotesReady,
    AgentRunning,
    Done,
    Failed,
}

impl MeetingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Capturing => "capturing",
            Self::Transcribing => "transcribing",
            Self::NotesReady => "notes_ready",
            Self::AgentRunning => "agent_running",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

impl TryFrom<&str> for MeetingStatus {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "capturing" => Ok(Self::Capturing),
            "transcribing" => Ok(Self::Transcribing),
            "notes_ready" => Ok(Self::NotesReady),
            "agent_running" => Ok(Self::AgentRunning),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            _ => Err(format!("Unknown meeting status: {}", value)),
        }
    }
}

/// Where a segment's `speaker` came from: the capture channel (mic = Me, system
/// audio = Them) or the transcription model's diarization labels.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeakerSource {
    Channel,
    Diarization,
}

impl SpeakerSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Channel => "channel",
            Self::Diarization => "diarization",
        }
    }
}

impl TryFrom<&str> for SpeakerSource {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "channel" => Ok(Self::Channel),
            "diarization" => Ok(Self::Diarization),
            _ => Err(format!("Unknown speaker source: {}", value)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SegmentStatus {
    Ok,
    Gap,
}

impl SegmentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Gap => "gap",
        }
    }
}

impl TryFrom<&str> for SegmentStatus {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "ok" => Ok(Self::Ok),
            "gap" => Ok(Self::Gap),
            _ => Err(format!("Unknown transcript segment status: {}", value)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub source_app: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: MeetingStatus,
    pub template_id: Option<String>,
    pub routed_skill_slug: Option<String>,
    pub agent_conversation_id: Option<String>,
    pub notes_markdown: Option<String>,
    pub notes_struct_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub meeting_id: String,
    pub seq: i64,
    pub speaker: Speaker,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub status: SegmentStatus,
    /// Raw diarization label from the model (e.g. "A", "speaker_0"), if any.
    pub speaker_label: Option<String>,
    /// Whether `speaker` was assigned by the capture channel or by diarization.
    pub speaker_source: SpeakerSource,
    pub created_at: i64,
}
