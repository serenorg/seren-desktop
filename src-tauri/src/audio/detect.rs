// ABOUTME: Pure meeting auto-detect decision logic for capture arming.
// ABOUTME: Keeps OS process probes separate from testable policy rules.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningProcess {
    pub name: String,
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
