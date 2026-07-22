// ABOUTME: Canonical provider-process sandbox policy and platform backends.
// ABOUTME: Keeps the security boundary in Rust before a child process is spawned.

mod landlock;
mod policy;
mod seatbelt;
mod windows;

pub use landlock::apply_landlock;
pub use policy::{SandboxError, SandboxMode, SandboxPolicy, encode_policy};
pub use seatbelt::{seatbelt_profile, wrap_spawn};
pub use windows::apply_and_spawn_contained;

pub fn sandbox_run_main(args: Vec<String>) -> ! {
    #[cfg(target_os = "windows")]
    {
        windows::sandbox_run_main(args);
    }

    #[cfg(not(target_os = "windows"))]
    {
        landlock::sandbox_run_main(args);
    }
}
