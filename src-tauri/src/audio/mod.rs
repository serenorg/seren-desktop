// ABOUTME: Shared audio pipeline primitives for meeting capture and dictation.
// ABOUTME: Exposes transcript, chunking, merge, retry, and notes parsing modules.

pub mod apm;
pub mod capture;
pub mod chunker;
pub mod cleanup;
pub mod detect;
pub mod lifecycle;
pub mod llm;
pub mod merge;
pub mod notes;
pub mod pipeline;
pub mod reconcile;
pub mod seren_notes_publish;
pub mod templates;
pub mod transcribe;
pub mod types;
