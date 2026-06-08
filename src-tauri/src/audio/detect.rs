// ABOUTME: Pure meeting auto-detect decision logic for capture arming.
// ABOUTME: Keeps OS process probes separate from testable policy rules.

use sysinfo::{ProcessRefreshKind, RefreshKind, System, UpdateKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningProcess {
    pub name: String,
}

/// Enumerate running process names via sysinfo. This is OS I/O kept out of the
/// pure `should_start_capture` policy so the decision stays unit-testable.
/// Reliable mic-in-use detection is not portable across macOS/Windows/Linux, so
/// we report `mic_in_use = false` and lean on the meeting-app allowlist path.
pub fn probe_running_processes() -> Vec<RunningProcess> {
    // Force the executable path to be resolved so `name()` is derived from the
    // exe basename on every platform. `ProcessRefreshKind::nothing()` leaves the
    // name empty for processes whose kernel-side name isn't readable, which
    // breaks the allowlist match. `with_exe(Always)` is the minimal kind that
    // guarantees a populated name.
    let system = System::new_with_specifics(
        RefreshKind::nothing()
            .with_processes(ProcessRefreshKind::nothing().with_exe(UpdateKind::Always)),
    );

    system
        .processes()
        .values()
        .map(|process| RunningProcess {
            name: process.name().to_string_lossy().into_owned(),
        })
        .collect()
}

pub fn should_start_capture(
    processes: &[RunningProcess],
    mic_in_use: bool,
    meeting_app_allowlist: &[String],
) -> bool {
    if mic_in_use {
        return true;
    }

    processes.iter().any(|process| {
        meeting_app_allowlist.iter().any(|allowed| {
            let allowed = allowed.trim();
            !allowed.is_empty()
                && process
                    .name
                    .to_lowercase()
                    .contains(&allowed.to_lowercase())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_start_capture_when_mic_is_in_use() {
        assert!(should_start_capture(&[], true, &[]));
    }

    #[test]
    fn should_start_capture_when_allowlisted_meeting_app_runs() {
        let processes = vec![RunningProcess {
            name: "Zoom.exe".to_string(),
        }];
        let allowlist = vec!["zoom".to_string()];

        assert!(should_start_capture(&processes, false, &allowlist));
    }

    #[test]
    fn should_not_start_capture_for_unrelated_processes() {
        let processes = vec![RunningProcess {
            name: "Spotify.exe".to_string(),
        }];
        let allowlist = vec!["zoom".to_string(), "teams".to_string()];

        assert!(!should_start_capture(&processes, false, &allowlist));
    }
}
