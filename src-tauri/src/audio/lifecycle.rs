// ABOUTME: Auto-record lifecycle decision core — when to auto-start and auto-stop capture.
// ABOUTME: Pure state machine over mic-activity, known-call-app, transcript, and calendar signals.

use serde::Serialize;

/// Tunable thresholds for the auto-record lifecycle. Defaults reflect the design
/// review: 3s start debounce so a mic blip can't trigger; 90s app-release grace
/// so mute/unmute and device switches don't end a live meeting; 15min silence
/// backstop as the hard runaway guard; 5min tail past a matched calendar end
/// (deliberately shorter than the in-window grace).
#[derive(Debug, Clone, Copy)]
pub struct LifecycleConfig {
    pub start_debounce_ms: i64,
    pub app_release_grace_ms: i64,
    pub silence_timeout_ms: i64,
    pub calendar_end_tail_ms: i64,
}

impl Default for LifecycleConfig {
    fn default() -> Self {
        Self {
            start_debounce_ms: 3_000,
            app_release_grace_ms: 90_000,
            silence_timeout_ms: 15 * 60_000,
            calendar_end_tail_ms: 5 * 60_000,
        }
    }
}

/// One observation of the world, sampled by the poll task (~every 2s). `gate_open`
/// is the auto-start gate: mic input is active AND a known conferencing app is
/// running. `source_app` carries the detected app name for the meeting record.
#[derive(Debug, Clone, Default)]
pub struct LifecycleSignal {
    pub now_ms: i64,
    pub gate_open: bool,
    pub source_app: Option<String>,
    /// Timestamp of the most recent persisted transcript segment, if any.
    pub last_segment_ms: Option<i64>,
    /// Scheduled end of the matched calendar event, if any.
    pub calendar_end_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    Idle,
    Recording,
}

/// Why an auto-started recording was stopped. Surfaced to the frontend so the
/// indicator can explain the stop, and recorded for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    AppReleased,
    Silence,
    CalendarEnd,
}

/// The single side effect the controller asks the wiring layer to perform on a
/// given tick. The wiring creates a fresh meeting per `StartCapture` (so each
/// call is its own record — no back-to-back merge) and stops capture on
/// `StopCapture`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LifecycleAction {
    StartCapture {
        #[serde(rename = "sourceApp")]
        source_app: Option<String>,
    },
    StopCapture {
        reason: StopReason,
    },
}

/// Pure auto-record decision engine. Holds no I/O — the wiring layer feeds it a
/// `LifecycleSignal` each tick and performs the returned `LifecycleAction`.
#[derive(Debug)]
pub struct LifecycleController {
    config: LifecycleConfig,
    state: LifecycleState,
    /// Since when the start gate has been continuously open (start debounce).
    gate_open_since: Option<i64>,
    /// Since when the meeting app has continuously released the mic (stop grace).
    app_release_since: Option<i64>,
    /// When the current recording started — silence is measured from here until
    /// the first transcript segment lands.
    recording_since: Option<i64>,
    /// After a manual stop, suppress auto-start until the gate fully closes, so
    /// stopping a recording while the call is still live can't instantly
    /// re-record it.
    suppress_until_gate_closes: bool,
}

impl LifecycleController {
    pub fn new(config: LifecycleConfig) -> Self {
        Self {
            config,
            state: LifecycleState::Idle,
            gate_open_since: None,
            app_release_since: None,
            recording_since: None,
            suppress_until_gate_closes: false,
        }
    }

    pub fn state(&self) -> LifecycleState {
        self.state
    }

    /// Record that the user manually stopped the active recording (via the
    /// indicator). Returns to `Idle` and suppresses auto-start until the call's
    /// mic session ends.
    pub fn note_manual_stop(&mut self) {
        self.state = LifecycleState::Idle;
        self.recording_since = None;
        self.app_release_since = None;
        self.gate_open_since = None;
        self.suppress_until_gate_closes = true;
    }

    /// The wiring failed to start the proposed capture (createMeeting / capture
    /// start threw). Reset to `Idle` so the next tick can re-propose — no
    /// suppression, since this was not a user-initiated stop.
    pub fn note_start_failed(&mut self) {
        self.state = LifecycleState::Idle;
        self.recording_since = None;
        self.app_release_since = None;
        self.gate_open_since = None;
    }

    /// Advance the state machine by one observation, returning the side effect to
    /// perform (at most one per tick).
    pub fn evaluate(&mut self, signal: &LifecycleSignal) -> Option<LifecycleAction> {
        match self.state {
            LifecycleState::Idle => self.evaluate_idle(signal),
            LifecycleState::Recording => self.evaluate_recording(signal),
        }
    }

    fn evaluate_idle(&mut self, signal: &LifecycleSignal) -> Option<LifecycleAction> {
        // Manual-stop suppression: hold off auto-start until the gate has fully
        // closed (the call actually ended), then re-arm normally.
        if self.suppress_until_gate_closes {
            if !signal.gate_open {
                self.suppress_until_gate_closes = false;
                self.gate_open_since = None;
            }
            return None;
        }

        if signal.gate_open {
            let opened_at = *self.gate_open_since.get_or_insert(signal.now_ms);
            if signal.now_ms - opened_at >= self.config.start_debounce_ms {
                self.state = LifecycleState::Recording;
                self.recording_since = Some(signal.now_ms);
                self.gate_open_since = None;
                self.app_release_since = None;
                return Some(LifecycleAction::StartCapture {
                    source_app: signal.source_app.clone(),
                });
            }
        } else {
            self.gate_open_since = None;
        }
        None
    }

    fn evaluate_recording(&mut self, signal: &LifecycleSignal) -> Option<LifecycleAction> {
        // 1) App-release grace. If the gate reopens inside the window, cancel the
        //    pending stop and keep recording.
        if !signal.gate_open {
            let released_at = *self.app_release_since.get_or_insert(signal.now_ms);
            if signal.now_ms - released_at >= self.config.app_release_grace_ms {
                return Some(self.stop(StopReason::AppReleased));
            }
        } else {
            self.app_release_since = None;
        }

        // 2) Silence backstop — the hard runaway guard. Measure from the last
        //    persisted segment, or from recording start if none has landed yet.
        let silence_anchor = signal.last_segment_ms.or(self.recording_since);
        if let Some(anchor) = silence_anchor {
            if signal.now_ms - anchor >= self.config.silence_timeout_ms {
                return Some(self.stop(StopReason::Silence));
            }
        }

        // 3) Matched calendar end + tail.
        if let Some(end) = signal.calendar_end_ms {
            if signal.now_ms >= end + self.config.calendar_end_tail_ms {
                return Some(self.stop(StopReason::CalendarEnd));
            }
        }

        None
    }

    fn stop(&mut self, reason: StopReason) -> LifecycleAction {
        self.state = LifecycleState::Idle;
        self.recording_since = None;
        self.app_release_since = None;
        self.gate_open_since = None;
        LifecycleAction::StopCapture { reason }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: LifecycleConfig = LifecycleConfig {
        start_debounce_ms: 3_000,
        app_release_grace_ms: 90_000,
        silence_timeout_ms: 900_000,
        calendar_end_tail_ms: 300_000,
    };

    fn gate(now_ms: i64, open: bool) -> LifecycleSignal {
        LifecycleSignal {
            now_ms,
            gate_open: open,
            source_app: open.then(|| "Zoom".to_string()),
            last_segment_ms: None,
            calendar_end_ms: None,
        }
    }

    /// The critical auto-record behaviors in one pass: debounced start,
    /// app-release grace with mid-window reversal, the silence backstop, and
    /// manual-stop suppression. These are the runaway-fix correctness guarantees.
    #[test]
    fn auto_record_decision_core() {
        let mut c = LifecycleController::new(CFG);

        // Start does not fire before the debounce elapses...
        assert_eq!(c.evaluate(&gate(0, true)), None);
        assert_eq!(c.evaluate(&gate(2_000, true)), None);
        // ...and fires once the gate has stayed open past it.
        assert_eq!(
            c.evaluate(&gate(3_000, true)),
            Some(LifecycleAction::StartCapture {
                source_app: Some("Zoom".to_string())
            })
        );
        assert_eq!(c.state(), LifecycleState::Recording);

        // App releases the mic: no stop inside the grace window...
        assert_eq!(c.evaluate(&gate(10_000, false)), None);
        // ...and a reversal inside the window cancels the pending stop.
        assert_eq!(c.evaluate(&gate(20_000, true)), None);
        assert_eq!(c.state(), LifecycleState::Recording);
        // Sustained release past the grace window stops with AppReleased.
        assert_eq!(c.evaluate(&gate(30_000, false)), None);
        assert_eq!(
            c.evaluate(&gate(30_000 + CFG.app_release_grace_ms, false)),
            Some(LifecycleAction::StopCapture {
                reason: StopReason::AppReleased
            })
        );
        assert_eq!(c.state(), LifecycleState::Idle);

        // Silence backstop: with the gate held open but no transcript segments,
        // recording auto-stops after the silence timeout (the runaway guard).
        let mut c = LifecycleController::new(CFG);
        c.evaluate(&gate(0, true));
        assert_eq!(
            c.evaluate(&gate(CFG.start_debounce_ms, true)),
            Some(LifecycleAction::StartCapture {
                source_app: Some("Zoom".to_string())
            })
        );
        assert_eq!(c.evaluate(&gate(CFG.start_debounce_ms + 60_000, true)), None);
        assert_eq!(
            c.evaluate(&gate(CFG.start_debounce_ms + CFG.silence_timeout_ms, true)),
            Some(LifecycleAction::StopCapture {
                reason: StopReason::Silence
            })
        );

        // Manual-stop suppression: after a manual stop while the call is still
        // live (gate open), auto-start must not re-fire until the gate closes.
        let mut c = LifecycleController::new(CFG);
        c.evaluate(&gate(0, true));
        c.evaluate(&gate(CFG.start_debounce_ms, true));
        assert_eq!(c.state(), LifecycleState::Recording);
        c.note_manual_stop();
        assert_eq!(c.state(), LifecycleState::Idle);
        // Gate still open across many ticks → still suppressed, no restart.
        assert_eq!(c.evaluate(&gate(100_000, true)), None);
        assert_eq!(c.evaluate(&gate(200_000, true)), None);
        // Call ends (gate closes) → suppression lifts.
        assert_eq!(c.evaluate(&gate(210_000, false)), None);
        // A fresh call re-arms and auto-starts again.
        c.evaluate(&gate(300_000, true));
        assert_eq!(
            c.evaluate(&gate(300_000 + CFG.start_debounce_ms, true)),
            Some(LifecycleAction::StartCapture {
                source_app: Some("Zoom".to_string())
            })
        );
    }
}
