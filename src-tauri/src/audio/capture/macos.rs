// ABOUTME: macOS CoreAudio process-tap capture for the system ("Them") meeting stream.
// ABOUTME: Taps all system output via an aggregate device and normalizes to 16 kHz mono PCM.

use std::ffi::CStr;
use std::ffi::c_void;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{AllocAnyThread, extern_class, msg_send};
use objc2_foundation::{NSArray, NSString, NSUUID};

use super::{AudioCaptureSource, CaptureError, FrameSender, PcmFrame, to_mono_16k};

extern_class!(
    // CATapDescription (CoreAudio, macOS 12+). Declared here because objc2 ships no
    // CoreAudio bindings crate; we only use its init/UUID/name/private selectors.
    #[unsafe(super(NSObject))]
    struct CATapDescription;
);

// === CoreAudio C types (hand-declared; the SDK's coreaudio types are not in deps) ===

type OSStatus = i32;
type AudioObjectID = u32;
type AudioObjectPropertySelector = u32;
type AudioObjectPropertyScope = u32;
type AudioObjectPropertyElement = u32;

const NO_ERR: OSStatus = 0;
const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: AudioObjectPropertyScope =
    fourcc(b"glob");
const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: AudioObjectPropertyElement = 0;
// 'tfmt' — kAudioTapPropertyFormat, an AudioStreamBasicDescription.
const K_AUDIO_TAP_PROPERTY_FORMAT: AudioObjectPropertySelector = fourcc(b"tfmt");

// Aggregate-device / sub-tap description dictionary keys (C string `#define`s).
const K_AUDIO_AGGREGATE_DEVICE_UID_KEY: &str = "uid";
const K_AUDIO_AGGREGATE_DEVICE_NAME_KEY: &str = "name";
const K_AUDIO_AGGREGATE_DEVICE_IS_PRIVATE_KEY: &str = "private";
const K_AUDIO_AGGREGATE_DEVICE_TAP_LIST_KEY: &str = "taps";
const K_AUDIO_AGGREGATE_DEVICE_TAP_AUTO_START_KEY: &str = "tapautostart";
const K_AUDIO_SUB_TAP_UID_KEY: &str = "uid";

/// Build a four-char-code constant the way CoreAudio's `'glob'` literals do.
const fn fourcc(code: &[u8; 4]) -> u32 {
    ((code[0] as u32) << 24)
        | ((code[1] as u32) << 16)
        | ((code[2] as u32) << 8)
        | (code[3] as u32)
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioObjectPropertyAddress {
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope,
    element: AudioObjectPropertyElement,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioStreamBasicDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioBuffer {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    number_buffers: u32,
    // Variable-length in C; we only ever read buffers[0] after bounds-checking
    // number_buffers, matching how the tap delivers a single interleaved buffer.
    buffers: [AudioBuffer; 1],
}

/// `OSStatus (*)(AudioObjectID, const AudioTimeStamp*, const AudioBufferList*,
/// const AudioTimeStamp*, AudioBufferList*, const AudioTimeStamp*, void*)`.
/// `AudioTimeStamp*` args are opaque here — we never dereference them.
type AudioDeviceIOProc = extern "C" fn(
    in_device: AudioObjectID,
    in_now: *const c_void,
    in_input_data: *const AudioBufferList,
    in_input_time: *const c_void,
    out_output_data: *mut AudioBufferList,
    in_output_time: *const c_void,
    in_client_data: *mut c_void,
) -> OSStatus;

type AudioDeviceIOProcID = *mut c_void;

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioHardwareCreateAggregateDevice(
        in_description: CFDictionaryRef,
        out_device_id: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(in_device_id: AudioObjectID) -> OSStatus;

    fn AudioObjectGetPropertyData(
        in_object_id: AudioObjectID,
        in_address: *const AudioObjectPropertyAddress,
        in_qualifier_data_size: u32,
        in_qualifier_data: *const c_void,
        io_data_size: *mut u32,
        out_data: *mut c_void,
    ) -> OSStatus;

    fn AudioDeviceCreateIOProcID(
        in_device: AudioObjectID,
        in_proc: AudioDeviceIOProc,
        in_client_data: *mut c_void,
        out_io_proc_id: *mut AudioDeviceIOProcID,
    ) -> OSStatus;
    fn AudioDeviceDestroyIOProcID(
        in_device: AudioObjectID,
        in_io_proc_id: AudioDeviceIOProcID,
    ) -> OSStatus;
    fn AudioDeviceStart(in_device: AudioObjectID, in_proc_id: AudioDeviceIOProcID)
    -> OSStatus;
    fn AudioDeviceStop(in_device: AudioObjectID, in_proc_id: AudioDeviceIOProcID)
    -> OSStatus;
}

// core-foundation 0.10's CFDictionaryRef alias lives in its sys crate; mirror the
// pointer type CoreAudio expects so our `extern` block stays self-contained.
type CFDictionaryRef = *const c_void;

// `AudioHardwareCreate/DestroyProcessTap` are macOS 14.2+ symbols. The app deploys
// to macOS 10.13, so strong-linking them would break launch on older systems.
// Resolve them lazily via `dlsym` instead and report `Unsupported` when absent.
type CreateProcessTapFn = unsafe extern "C" fn(*mut AnyObject, *mut AudioObjectID) -> OSStatus;
type DestroyProcessTapFn = unsafe extern "C" fn(AudioObjectID) -> OSStatus;

fn create_process_tap() -> Option<CreateProcessTapFn> {
    static ADDR: OnceLock<Option<usize>> = OnceLock::new();
    (*ADDR.get_or_init(|| dlsym_addr(c"AudioHardwareCreateProcessTap")))
        // SAFETY: the resolved address is the real CoreAudio function with this ABI.
        .map(|addr| unsafe { std::mem::transmute::<usize, CreateProcessTapFn>(addr) })
}

fn destroy_process_tap() -> Option<DestroyProcessTapFn> {
    static ADDR: OnceLock<Option<usize>> = OnceLock::new();
    (*ADDR.get_or_init(|| dlsym_addr(c"AudioHardwareDestroyProcessTap")))
        // SAFETY: the resolved address is the real CoreAudio function with this ABI.
        .map(|addr| unsafe { std::mem::transmute::<usize, DestroyProcessTapFn>(addr) })
}

/// Resolve a symbol from the global namespace; `None` if the running OS lacks it.
fn dlsym_addr(name: &CStr) -> Option<usize> {
    // SAFETY: RTLD_DEFAULT search with a valid C string; returns null when absent.
    let ptr = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if ptr.is_null() { None } else { Some(ptr as usize) }
}

/// Destroy a process tap when the entry point is available — which it always is
/// once a tap was created (same process, same dlsym result).
fn destroy_tap(tap: AudioObjectID) {
    if let Some(destroy) = destroy_process_tap() {
        // SAFETY: `tap` came from AudioHardwareCreateProcessTap; destroyed once.
        unsafe { destroy(tap) };
    }
}

// === Capture source ===

/// Captures all system output audio through a private CoreAudio process tap fed
/// into a private aggregate device, so the remote side of a call ("Them") becomes
/// the meeting stream. Requires macOS 14.2+.
pub struct CoreAudioTapSource {
    stop_flag: Arc<AtomicBool>,
    state: Option<Box<CaptureState>>,
}

impl CoreAudioTapSource {
    pub fn new() -> Self {
        Self {
            stop_flag: Arc::new(AtomicBool::new(false)),
            state: None,
        }
    }
}

impl Default for CoreAudioTapSource {
    fn default() -> Self {
        Self::new()
    }
}

/// Heap-pinned data the realtime IOProc reads via its `void* clientData`. The
/// pointer handed to CoreAudio must outlive the running device, so this is owned
/// by [`CaptureState`] and only freed after the device is stopped.
struct IoProcContext {
    sink: FrameSender,
    channels: u16,
    sample_rate: u32,
}

/// Live CoreAudio objects retained for the duration of a capture, torn down in
/// reverse creation order on [`stop`](AudioCaptureSource::stop).
struct CaptureState {
    aggregate_device: AudioObjectID,
    tap: AudioObjectID,
    io_proc_id: AudioDeviceIOProcID,
    // Boxed so its address is stable while handed to the C callback.
    context: Box<IoProcContext>,
}

// The retained CoreAudio object IDs and the boxed context are owned solely by the
// pipeline thread; nothing here is shared, so moving it across threads is sound.
unsafe impl Send for CaptureState {}

impl AudioCaptureSource for CoreAudioTapSource {
    fn start(&mut self, sink: FrameSender) -> Result<(), CaptureError> {
        if self.state.is_some() {
            return Ok(());
        }
        self.stop_flag.store(false, Ordering::SeqCst);
        let state = start_capture(sink)?;
        self.state = Some(Box::new(state));
        Ok(())
    }

    fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(state) = self.state.take() {
            teardown(*state);
        }
    }
}

impl Drop for CoreAudioTapSource {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Create the tap + aggregate device, register the IOProc, and start IO.
fn start_capture(sink: FrameSender) -> Result<CaptureState, CaptureError> {
    // Resolve the 14.2+ tap entry points before touching the API; bail cleanly on
    // older macOS so the app stays mic-only instead of crashing.
    let create_tap = create_process_tap().ok_or_else(|| {
        CaptureError::Unsupported(
            "system-audio capture needs macOS 14.2+ (process-tap API unavailable)".to_string(),
        )
    })?;

    let description = build_tap_description();
    let tap_uuid = tap_uuid_string(&description);

    // SAFETY: `description` is a valid CATapDescription; out-param is a live local.
    let mut tap: AudioObjectID = 0;
    let status = unsafe {
        create_tap(Retained::as_ptr(&description) as *mut AnyObject, &mut tap)
    };
    if status != NO_ERR {
        return Err(CaptureError::Unsupported(format!(
            "AudioHardwareCreateProcessTap failed (OSStatus {status}); check audio-capture permission"
        )));
    }

    let aggregate_uid = format!("com.serendb.meeting.tap.{tap_uuid}");
    let dict = build_aggregate_description(&aggregate_uid, &tap_uuid);

    let mut aggregate_device: AudioObjectID = 0;
    // SAFETY: `dict` is a valid CFDictionary held alive for the call; out-param local.
    let status = unsafe {
        AudioHardwareCreateAggregateDevice(
            dict.as_concrete_TypeRef() as CFDictionaryRef,
            &mut aggregate_device,
        )
    };
    if status != NO_ERR {
        destroy_tap(tap);
        return Err(CaptureError::Device(format!(
            "AudioHardwareCreateAggregateDevice failed (OSStatus {status})"
        )));
    }

    let (channels, sample_rate) = tap_stream_format(tap).unwrap_or((2, 48_000));

    let mut context = Box::new(IoProcContext {
        sink,
        channels,
        sample_rate,
    });
    let context_ptr = context.as_mut() as *mut IoProcContext as *mut c_void;

    let mut io_proc_id: AudioDeviceIOProcID = std::ptr::null_mut();
    // SAFETY: aggregate_device is live; io_proc is a valid `extern "C"` fn; the
    // context pointer stays valid because `context` is owned by CaptureState and
    // only dropped after AudioDeviceDestroyIOProcID in teardown.
    let status = unsafe {
        AudioDeviceCreateIOProcID(
            aggregate_device,
            capture_io_proc,
            context_ptr,
            &mut io_proc_id,
        )
    };
    if status != NO_ERR || io_proc_id.is_null() {
        // SAFETY: the aggregate device was created above and is destroyed once.
        unsafe { AudioHardwareDestroyAggregateDevice(aggregate_device) };
        destroy_tap(tap);
        return Err(CaptureError::Device(format!(
            "AudioDeviceCreateIOProcID failed (OSStatus {status})"
        )));
    }

    // SAFETY: device + proc id are live and paired.
    let status = unsafe { AudioDeviceStart(aggregate_device, io_proc_id) };
    if status != NO_ERR {
        // SAFETY: proc/device created above; tear them down once each.
        unsafe {
            AudioDeviceDestroyIOProcID(aggregate_device, io_proc_id);
            AudioHardwareDestroyAggregateDevice(aggregate_device);
        }
        destroy_tap(tap);
        return Err(CaptureError::Device(format!(
            "AudioDeviceStart failed (OSStatus {status})"
        )));
    }

    Ok(CaptureState {
        aggregate_device,
        tap,
        io_proc_id,
        context,
    })
}

/// Stop IO and destroy CoreAudio objects in reverse order. The boxed context is
/// dropped last, after the IOProc that referenced it can no longer fire.
fn teardown(state: CaptureState) {
    // SAFETY: each object was created in `start_capture` and is destroyed exactly
    // once here; AudioDeviceStop precedes DestroyIOProcID so no callback races the
    // context drop.
    unsafe {
        AudioDeviceStop(state.aggregate_device, state.io_proc_id);
        AudioDeviceDestroyIOProcID(state.aggregate_device, state.io_proc_id);
        AudioHardwareDestroyAggregateDevice(state.aggregate_device);
    }
    destroy_tap(state.tap);
    drop(state.context);
}

/// Allocate a `CATapDescription` tapping all system audio (excluding nothing) and
/// configure it as a private, named tap.
fn build_tap_description() -> Retained<CATapDescription> {
    let exclude: Retained<NSArray<NSObject>> = NSArray::new();
    let name = NSString::from_str("Seren Meeting Capture");

    // SAFETY: CATapDescription responds to these selectors (CATapDescription.h);
    // `init…ExcludeProcesses:` takes an NSArray<NSNumber*> — an empty array excludes
    // nothing, i.e. taps every process. `alloc` + designated init returns a +1
    // reference that `Retained` takes ownership of.
    unsafe {
        let alloc = CATapDescription::alloc();
        let desc: Retained<CATapDescription> =
            msg_send![alloc, initStereoGlobalTapButExcludeProcesses: &*exclude];
        let _: () = msg_send![&*desc, setName: &*name];
        let _: () = msg_send![&*desc, setPrivate: true];
        desc
    }
}

/// Read the tap's `UUID` property and render it as a UID string for the sub-tap.
fn tap_uuid_string(description: &Retained<CATapDescription>) -> String {
    // SAFETY: CATapDescription exposes a `UUID` (NSUUID) property; `UUIDString`
    // returns an autoreleased NSString we copy into an owned Rust String.
    unsafe {
        let uuid: Retained<NSUUID> = msg_send![&**description, UUID];
        let s: Retained<NSString> = msg_send![&*uuid, UUIDString];
        s.to_string()
    }
}

/// Build the private aggregate-device description: one sub-tap referencing the
/// process tap by UID, auto-starting so IO begins immediately.
fn build_aggregate_description(
    aggregate_uid: &str,
    tap_uuid: &str,
) -> CFDictionary<CFString, core_foundation::base::CFType> {
    use core_foundation::base::CFType;

    let sub_tap = CFDictionary::from_CFType_pairs(&[(
        CFString::new(K_AUDIO_SUB_TAP_UID_KEY),
        CFString::new(tap_uuid).as_CFType(),
    )]);
    let tap_list = CFArray::from_CFTypes(&[sub_tap]);

    let pairs: Vec<(CFString, CFType)> = vec![
        (
            CFString::new(K_AUDIO_AGGREGATE_DEVICE_NAME_KEY),
            CFString::new("Seren Meeting Aggregate").as_CFType(),
        ),
        (
            CFString::new(K_AUDIO_AGGREGATE_DEVICE_UID_KEY),
            CFString::new(aggregate_uid).as_CFType(),
        ),
        (
            CFString::new(K_AUDIO_AGGREGATE_DEVICE_IS_PRIVATE_KEY),
            CFBoolean::true_value().as_CFType(),
        ),
        (
            CFString::new(K_AUDIO_AGGREGATE_DEVICE_TAP_AUTO_START_KEY),
            CFBoolean::true_value().as_CFType(),
        ),
        (
            CFString::new(K_AUDIO_AGGREGATE_DEVICE_TAP_LIST_KEY),
            tap_list.as_CFType(),
        ),
    ];
    CFDictionary::from_CFType_pairs(&pairs)
}

/// Query the tap's stream format, returning `(channels, sample_rate)`.
fn tap_stream_format(tap: AudioObjectID) -> Option<(u16, u32)> {
    let address = AudioObjectPropertyAddress {
        selector: K_AUDIO_TAP_PROPERTY_FORMAT,
        scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };
    let mut asbd = AudioStreamBasicDescription {
        sample_rate: 0.0,
        format_id: 0,
        format_flags: 0,
        bytes_per_packet: 0,
        frames_per_packet: 0,
        bytes_per_frame: 0,
        channels_per_frame: 0,
        bits_per_channel: 0,
        reserved: 0,
    };
    let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;

    // SAFETY: `tap` is a live AudioObjectID; `address` and `asbd` are valid locals
    // and `size` matches the out buffer exactly.
    let status = unsafe {
        AudioObjectGetPropertyData(
            tap,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            &mut asbd as *mut AudioStreamBasicDescription as *mut c_void,
        )
    };
    if status != NO_ERR || asbd.channels_per_frame == 0 || asbd.sample_rate <= 0.0 {
        return None;
    }
    Some((asbd.channels_per_frame as u16, asbd.sample_rate as u32))
}

/// Scale one clamped Float32 sample to i16 using the positive full-scale factor.
#[inline]
fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

/// Average non-interleaved (planar) Float32 channels into mono i16. Each slice is
/// one channel; frames past the shortest channel are dropped so a ragged callback
/// can never read past a buffer. Returns empty when there are no channels.
fn planar_to_mono_i16(channels: &[&[f32]]) -> Vec<i16> {
    let Some(frames) = channels.iter().map(|c| c.len()).min() else {
        return Vec::new();
    };
    if frames == 0 {
        return Vec::new();
    }
    let divisor = channels.len() as f32;
    let mut out = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut sum = 0.0f32;
        for channel in channels {
            sum += channel[frame];
        }
        out.push(f32_to_i16(sum / divisor));
    }
    out
}

/// Realtime IOProc: convert the tap's Float32 input to normalized 16 kHz mono PCM
/// and push it into the sink. The tap may deliver audio interleaved (one buffer,
/// N channels) or non-interleaved/planar (N buffers, one channel each); both are
/// handled so a planar tap doesn't silently drop every channel but the first.
/// Runs on a CoreAudio thread; it must not allocate-and-block beyond the bounded
/// work here and never unwinds.
extern "C" fn capture_io_proc(
    _in_device: AudioObjectID,
    _in_now: *const c_void,
    in_input_data: *const AudioBufferList,
    _in_input_time: *const c_void,
    _out_output_data: *mut AudioBufferList,
    _in_output_time: *const c_void,
    in_client_data: *mut c_void,
) -> OSStatus {
    if in_input_data.is_null() || in_client_data.is_null() {
        return NO_ERR;
    }
    // SAFETY: `in_client_data` is the `IoProcContext` pointer registered with
    // AudioDeviceCreateIOProcID; it outlives the running device. We only take a
    // shared reference and never move out of it.
    let context = unsafe { &*(in_client_data as *const IoProcContext) };

    // SAFETY: CoreAudio guarantees a valid AudioBufferList here.
    let list = unsafe { &*in_input_data };
    let buffer_count = list.number_buffers as usize;
    if buffer_count == 0 {
        return NO_ERR;
    }
    // SAFETY: CoreAudio lays out `number_buffers` contiguous AudioBuffer structs
    // starting at the `buffers` flexible-array head; reading `buffer_count` of
    // them is the canonical AudioBufferList walk.
    let buffers = unsafe { std::slice::from_raw_parts(list.buffers.as_ptr(), buffer_count) };

    let normalized = if buffer_count > 1 {
        // Non-interleaved (planar): one channel per buffer. Average to mono so the
        // channels past the first aren't dropped, then resample.
        let channels: Vec<&[f32]> = buffers
            .iter()
            .filter_map(|buffer| {
                if buffer.data.is_null() || buffer.data_byte_size == 0 {
                    return None;
                }
                let count = buffer.data_byte_size as usize / std::mem::size_of::<f32>();
                if count == 0 {
                    return None;
                }
                // SAFETY: each buffer's `data` points to `data_byte_size` bytes of
                // Float32 PCM owned by CoreAudio for the duration of this call.
                Some(unsafe { std::slice::from_raw_parts(buffer.data as *const f32, count) })
            })
            .collect();
        let mono = planar_to_mono_i16(&channels);
        to_mono_16k(&mono, 1, context.sample_rate)
    } else {
        // Interleaved: a single buffer holds `number_channels` interleaved samples.
        let buffer = buffers[0];
        if buffer.data.is_null() || buffer.data_byte_size == 0 {
            return NO_ERR;
        }
        let sample_count = (buffer.data_byte_size as usize) / std::mem::size_of::<f32>();
        if sample_count == 0 {
            return NO_ERR;
        }
        // SAFETY: `buffer.data` points to `data_byte_size` bytes of Float32 PCM
        // owned by CoreAudio for the duration of this call; we copy out before
        // returning.
        let floats =
            unsafe { std::slice::from_raw_parts(buffer.data as *const f32, sample_count) };
        let mut pcm: Vec<i16> = Vec::with_capacity(sample_count);
        for &sample in floats {
            pcm.push(f32_to_i16(sample));
        }
        let channels = if buffer.number_channels > 0 {
            buffer.number_channels as u16
        } else {
            context.channels
        };
        to_mono_16k(&pcm, channels, context.sample_rate)
    };

    if !normalized.is_empty() {
        let _ = context.sink.send(PcmFrame { samples: normalized });
    }
    NO_ERR
}

#[cfg(test)]
mod tests {
    use super::{f32_to_i16, planar_to_mono_i16};

    #[test]
    fn f32_to_i16_clamps_and_scales() {
        assert_eq!(f32_to_i16(0.0), 0);
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), -i16::MAX);
    }

    #[test]
    fn planar_averages_channels_frame_wise() {
        let left = [1.0f32, -1.0, 0.0];
        let right = [1.0f32, -1.0, 0.0];
        // (1+1)/2 -> +full, (-1-1)/2 -> -full, (0+0)/2 -> 0
        assert_eq!(
            planar_to_mono_i16(&[&left, &right]),
            vec![i16::MAX, -i16::MAX, 0]
        );
    }

    #[test]
    fn planar_single_channel_passes_through() {
        let only = [0.0f32, 0.5, -0.5];
        assert_eq!(
            planar_to_mono_i16(&[&only]),
            vec![f32_to_i16(0.0), f32_to_i16(0.5), f32_to_i16(-0.5)]
        );
    }

    #[test]
    fn planar_clips_to_shortest_channel_without_overrun() {
        let long = [0.25f32, 0.25, 0.25];
        let short = [0.25f32];
        // Min length is 1 frame; the ragged second buffer is never read past end.
        assert_eq!(planar_to_mono_i16(&[&long, &short]), vec![f32_to_i16(0.25)]);
    }

    #[test]
    fn planar_no_channels_is_empty() {
        let none: [&[f32]; 0] = [];
        assert!(planar_to_mono_i16(&none).is_empty());
    }
}
