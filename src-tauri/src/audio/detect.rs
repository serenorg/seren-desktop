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

/// Pure decision for "is any input device currently engaged" — used by both
/// platform probes after they enumerate input devices. Today's default-input
/// gate misses every external mic (USB headset, audio interface, AirPods)
/// that isn't set as System Settings → Sound → Input default; this seam ORs
/// the per-device states so the prompt fires regardless of which input the
/// conferencing app picked. #2364.
pub fn any_input_device_running(states: impl IntoIterator<Item = bool>) -> bool {
    states.into_iter().any(|running| running)
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
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT: AudioObjectPropertyScope = fourcc(b"inpt");
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: AudioObjectPropertyElement = 0;
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: AudioObjectPropertySelector =
        fourcc(b"dIn ");
    const K_AUDIO_HARDWARE_PROPERTY_DEVICES: AudioObjectPropertySelector = fourcc(b"dev#");
    const K_AUDIO_DEVICE_PROPERTY_STREAM_CONFIGURATION: AudioObjectPropertySelector =
        fourcc(b"slay");
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

        fn AudioObjectGetPropertyDataSize(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            out_data_size: *mut u32,
        ) -> OSStatus;
    }

    pub(super) fn probe_audio_activity() -> AudioActivity {
        let input_active = any_input_device_is_running();
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

    /// OR `IsRunningSomewhere` across every input-capable device, not just the
    /// default. Fixes #2364 where Zoom/etc. on a non-default mic (USB
    /// headset, audio interface, AirPods) never tripped the prompt. Falls
    /// back to the default-only path if device enumeration fails so the
    /// probe is never worse than the prior behavior.
    fn any_input_device_is_running() -> bool {
        let devices = list_all_audio_device_ids();
        if devices.is_empty() {
            return default_input_device_is_running();
        }
        super::any_input_device_running(devices.into_iter().filter_map(|device_id| {
            if !device_has_input_streams(device_id) {
                return None;
            }
            Some(
                audio_object_u32(
                    device_id,
                    K_AUDIO_DEVICE_PROPERTY_DEVICE_IS_RUNNING_SOMEWHERE,
                )
                .is_some_and(|running| running != 0),
            )
        }))
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

    fn list_all_audio_device_ids() -> Vec<AudioObjectID> {
        let address = AudioObjectPropertyAddress {
            selector: K_AUDIO_HARDWARE_PROPERTY_DEVICES,
            scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut size: u32 = 0;
        // SAFETY: read-only CoreAudio size query; all pointers reference live
        // stack values for the duration of the call.
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                K_AUDIO_OBJECT_SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                &mut size,
            )
        };
        if status != NO_ERR || size == 0 {
            return Vec::new();
        }
        let count = size as usize / std::mem::size_of::<AudioObjectID>();
        let mut buffer: Vec<AudioObjectID> = vec![0; count];
        let mut io_size = size;
        // SAFETY: buffer is sized to exactly `size` bytes, matching the size
        // CoreAudio just reported. Pointer is exclusive to this call.
        let status = unsafe {
            AudioObjectGetPropertyData(
                K_AUDIO_OBJECT_SYSTEM_OBJECT,
                &address,
                0,
                std::ptr::null(),
                &mut io_size,
                buffer.as_mut_ptr() as *mut c_void,
            )
        };
        if status != NO_ERR {
            return Vec::new();
        }
        buffer.truncate(io_size as usize / std::mem::size_of::<AudioObjectID>());
        buffer
    }

    /// Returns true when the device exposes at least one input buffer with at
    /// least one channel. Used to skip output-only endpoints (HDMI, speakers,
    /// AirPlay) — otherwise an active speaker would flip `IsRunningSomewhere`
    /// and surface a fake record prompt.
    fn device_has_input_streams(device_id: AudioObjectID) -> bool {
        let address = AudioObjectPropertyAddress {
            selector: K_AUDIO_DEVICE_PROPERTY_STREAM_CONFIGURATION,
            scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
            element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut size: u32 = 0;
        // SAFETY: read-only CoreAudio size query against the device id.
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                device_id,
                &address,
                0,
                std::ptr::null(),
                &mut size,
            )
        };
        if status != NO_ERR || (size as usize) < std::mem::size_of::<u32>() {
            return false;
        }
        let mut buffer: Vec<u8> = vec![0; size as usize];
        let mut io_size = size;
        // SAFETY: buffer is sized to exactly `size`; CoreAudio fills the
        // `AudioBufferList` layout described in the Apple docs.
        let status = unsafe {
            AudioObjectGetPropertyData(
                device_id,
                &address,
                0,
                std::ptr::null(),
                &mut io_size,
                buffer.as_mut_ptr() as *mut c_void,
            )
        };
        if status != NO_ERR {
            return false;
        }
        // AudioBufferList: u32 mNumberBuffers, followed by mNumberBuffers
        // AudioBuffer structs { u32 mNumberChannels; u32 mDataByteSize;
        // *mut c_void mData; }. We only need to know if any buffer has at
        // least one channel, so reach into the first u32 of each entry.
        let m_number_buffers = u32::from_ne_bytes(
            buffer
                .get(..4)
                .and_then(|s| s.try_into().ok())
                .unwrap_or([0, 0, 0, 0]),
        );
        if m_number_buffers == 0 {
            return false;
        }
        let buffer_struct_size = std::mem::size_of::<u32>() * 2 + std::mem::size_of::<*mut c_void>();
        for i in 0..m_number_buffers as usize {
            let offset = std::mem::size_of::<u32>() + i * buffer_struct_size;
            let Some(slice) = buffer.get(offset..offset + 4) else {
                break;
            };
            let channels =
                u32::from_ne_bytes(slice.try_into().unwrap_or([0, 0, 0, 0]));
            if channels > 0 {
                return true;
            }
        }
        false
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
        AudioSessionStateActive, DEVICE_STATE_ACTIVE, IAudioSessionManager2, IMMDevice,
        IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
    };
    use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};

    pub(super) fn probe_audio_activity() -> AudioActivity {
        let input_active = any_capture_session_is_active();
        AudioActivity {
            input_active,
            source_app: input_active
                .then(known_call_app_from_system_processes)
                .flatten(),
        }
    }

    /// Walk every active capture endpoint, not just the default
    /// communications one. Fixes #2364 where Zoom/etc. on a non-default mic
    /// (USB headset, dock mic, virtual driver) never tripped the prompt.
    fn any_capture_session_is_active() -> bool {
        if initialize_mta().ok().is_err() {
            return false;
        }

        let enumerator: IMMDeviceEnumerator =
            match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
                Ok(enumerator) => enumerator,
                Err(_) => return false,
            };
        let Ok(endpoints) =
            (unsafe { enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) })
        else {
            return false;
        };
        let Ok(endpoint_count) = (unsafe { endpoints.GetCount() }) else {
            return false;
        };

        super::any_input_device_running((0..endpoint_count).filter_map(|index| {
            let device = unsafe { endpoints.Item(index) }.ok()?;
            Some(endpoint_has_active_session(&device))
        }))
    }

    fn endpoint_has_active_session(device: &IMMDevice) -> bool {
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

    #[test]
    fn any_input_device_running_fires_when_a_non_default_input_is_engaged() {
        // The exact scenario from #2364: the system-default input (built-in
        // mic) is idle, the USB headset Zoom is using is running. Before this
        // seam, the probe only inspected the default and returned false.
        let default_built_in_mic_idle = false;
        let usb_headset_used_by_zoom = true;
        assert!(any_input_device_running([
            default_built_in_mic_idle,
            usb_headset_used_by_zoom
        ]));
    }

    #[test]
    fn any_input_device_running_is_false_when_every_input_is_idle() {
        assert!(!any_input_device_running([false, false, false]));
    }

    #[test]
    fn any_input_device_running_is_false_for_an_empty_device_list() {
        let empty: [bool; 0] = [];
        assert!(!any_input_device_running(empty));
    }
}
