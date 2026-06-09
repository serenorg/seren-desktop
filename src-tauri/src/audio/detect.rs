// ABOUTME: Meeting auto-detect decision logic for capture arming.
// ABOUTME: Uses passive audio activity probes plus best-effort app naming.

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AudioActivity {
    pub input_active: bool,
    pub source_app: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAutodetectResult {
    pub detected: bool,
    pub source_app: Option<String>,
}

/// Read whether the default input device is actively used by another app. The
/// platform probes are passive OS status checks; they do not open or record mic
/// audio.
pub fn probe_audio_activity() -> AudioActivity {
    platform_audio::probe_audio_activity()
}

pub fn should_start_capture(activity: AudioActivity) -> bool {
    activity.input_active
}

pub fn meeting_detection(activity: AudioActivity) -> MeetingAutodetectResult {
    if should_start_capture(activity.clone()) {
        return MeetingAutodetectResult {
            detected: true,
            source_app: activity.source_app,
        };
    }
    MeetingAutodetectResult {
        detected: false,
        source_app: None,
    }
}

fn known_call_app_from_process_list(process_list: &str) -> Option<String> {
    let lower = process_list.to_lowercase();
    for (needles, display) in KNOWN_CALL_APPS {
        if needles.iter().any(|needle| lower.contains(needle)) {
            return Some((*display).to_string());
        }
    }
    None
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn known_call_app_from_system_processes() -> Option<String> {
    let output = system_process_list()?;
    known_call_app_from_process_list(&output)
}

#[cfg(target_os = "windows")]
fn system_process_list() -> Option<String> {
    let output = std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[cfg(target_os = "macos")]
fn system_process_list() -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "comm="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

const KNOWN_CALL_APPS: &[(&[&str], &str)] = &[
    (&["zoom.us", "zoom.exe"], "Zoom"),
    (&["discord"], "Discord"),
    (&["whatsapp"], "WhatsApp"),
    (
        &["microsoft teams", "ms-teams", "teams.exe"],
        "Microsoft Teams",
    ),
    (&["slack"], "Slack"),
    (&["facetime"], "FaceTime"),
    (&["telegram"], "Telegram"),
    (&["google chrome", "chrome.exe"], "Google Chrome"),
    (&["arc.app", "/arc", "arc.exe"], "Arc"),
    (&["safari"], "Safari"),
    (&["firefox"], "Firefox"),
    (&["brave browser", "brave.exe"], "Brave"),
];

#[cfg(target_os = "macos")]
mod platform_audio {
    use super::{AudioActivity, known_call_app_from_system_processes};
    use std::ffi::c_void;

    type OSStatus = i32;
    type AudioObjectID = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;

    const NO_ERR: OSStatus = 0;
    const K_AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectID = 1;
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: AudioObjectPropertyScope = fourcc(b"glob");
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: AudioObjectPropertyElement = 0;
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: AudioObjectPropertySelector =
        fourcc(b"dIn ");
    const K_AUDIO_DEVICE_PROPERTY_DEVICE_IS_RUNNING_SOMEWHERE: AudioObjectPropertySelector =
        fourcc(b"gone");

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioObjectPropertyAddress {
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        element: AudioObjectPropertyElement,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyData(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            io_data_size: *mut u32,
            out_data: *mut c_void,
        ) -> OSStatus;
    }

    pub(super) fn probe_audio_activity() -> AudioActivity {
        let input_active = default_input_device_is_running();
        AudioActivity {
            input_active,
            source_app: input_active
                .then(known_call_app_from_system_processes)
                .flatten(),
        }
    }

    const fn fourcc(code: &[u8; 4]) -> u32 {
        ((code[0] as u32) << 24)
            | ((code[1] as u32) << 16)
            | ((code[2] as u32) << 8)
            | (code[3] as u32)
    }

    fn default_input_device_is_running() -> bool {
        let Some(device_id) = audio_object_u32(
            K_AUDIO_OBJECT_SYSTEM_OBJECT,
            K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE,
        ) else {
            return false;
        };
        if device_id == 0 {
            return false;
        }

        audio_object_u32(
            device_id,
            K_AUDIO_DEVICE_PROPERTY_DEVICE_IS_RUNNING_SOMEWHERE,
        )
        .is_some_and(|running| running != 0)
    }

    fn audio_object_u32(
        object_id: AudioObjectID,
        selector: AudioObjectPropertySelector,
    ) -> Option<u32> {
        let address = AudioObjectPropertyAddress {
            selector,
            scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut value = 0_u32;
        let mut size = std::mem::size_of::<u32>() as u32;

        // SAFETY: `object_id` and property selector are read-only CoreAudio
        // queries; all pointers reference live stack values for this call.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object_id,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                &mut value as *mut u32 as *mut c_void,
            )
        };

        if status == NO_ERR && size as usize == std::mem::size_of::<u32>() {
            Some(value)
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
mod platform_audio {
    use super::{AudioActivity, known_call_app_from_system_processes};
    use wasapi::initialize_mta;
    use windows::Win32::Media::Audio::{
        AudioSessionStateActive, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
        eCapture, eCommunications,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};

    pub(super) fn probe_audio_activity() -> AudioActivity {
        let input_active = default_capture_session_is_active();
        AudioActivity {
            input_active,
            source_app: input_active
                .then(known_call_app_from_system_processes)
                .flatten(),
        }
    }

    fn default_capture_session_is_active() -> bool {
        if initialize_mta().ok().is_err() {
            return false;
        }

        let enumerator: IMMDeviceEnumerator =
            match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
                Ok(enumerator) => enumerator,
                Err(_) => return false,
            };
        let Ok(device) = (unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications) })
        else {
            return false;
        };
        let Ok(manager) = (unsafe { device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) })
        else {
            return false;
        };
        let Ok(sessions) = (unsafe { manager.GetSessionEnumerator() }) else {
            return false;
        };
        let Ok(count) = (unsafe { sessions.GetCount() }) else {
            return false;
        };

        for index in 0..count {
            let Ok(session) = (unsafe { sessions.GetSession(index) }) else {
                continue;
            };
            if unsafe { session.GetState() }.is_ok_and(|state| state == AudioSessionStateActive) {
                return true;
            }
        }

        false
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform_audio {
    use super::AudioActivity;

    pub(super) fn probe_audio_activity() -> AudioActivity {
        AudioActivity::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_start_capture_when_mic_is_in_use() {
        assert!(should_start_capture(AudioActivity {
            input_active: true,
            ..Default::default()
        }));
    }

    #[test]
    fn should_not_start_capture_when_app_has_no_input_activity() {
        assert!(!should_start_capture(AudioActivity::default()));
    }

    #[test]
    fn should_start_capture_when_input_device_is_active_for_browser_meetings() {
        assert!(should_start_capture(AudioActivity {
            input_active: true,
            ..Default::default()
        }));
    }

    #[test]
    fn should_not_start_capture_without_input_activity() {
        assert!(!should_start_capture(AudioActivity::default()));
    }

    #[test]
    fn detection_includes_source_app_only_when_input_is_active() {
        let inactive = meeting_detection(AudioActivity {
            input_active: false,
            source_app: Some("Discord".to_string()),
        });
        assert!(!inactive.detected);
        assert_eq!(inactive.source_app, None);

        let active = meeting_detection(AudioActivity {
            input_active: true,
            source_app: Some("Discord".to_string()),
        });
        assert!(active.detected);
        assert_eq!(active.source_app.as_deref(), Some("Discord"));
    }

    #[test]
    fn known_call_app_detection_prefers_specific_voice_apps_over_browsers() {
        let processes = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\
            /Applications/Discord.app/Contents/MacOS/Discord\n";

        assert_eq!(
            known_call_app_from_process_list(processes).as_deref(),
            Some("Discord")
        );
    }
}
