// ABOUTME: Shared audio pipeline primitives for meeting capture and dictation.
// ABOUTME: Exposes transcript, chunking, merge, retry, and notes parsing modules.

pub mod capture;
pub mod chunker;
pub mod cleanup;
pub mod detect;
pub mod merge;
pub mod notes;
pub mod pipeline;
pub mod templates;
pub mod transcribe;
pub mod types;
