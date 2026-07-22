// ABOUTME: Canonical provider-process sandbox policy and platform backends.
// ABOUTME: Keeps the security boundary in Rust before a child process is spawned.

mod landlock;
mod policy;
mod seatbelt;

pub use landlock::{apply_landlock, sandbox_run_main};
pub use policy::{SandboxError, SandboxMode, SandboxPolicy, encode_policy};
pub use seatbelt::{seatbelt_profile, wrap_spawn};
