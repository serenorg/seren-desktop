// ABOUTME: Canonical provider-process sandbox policy and platform backends.
// ABOUTME: Keeps the security boundary in Rust before a child process is spawned.

mod policy;
mod seatbelt;

pub use policy::{SandboxError, SandboxMode, SandboxPolicy};
pub use seatbelt::{seatbelt_profile, wrap_spawn};
