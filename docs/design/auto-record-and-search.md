<!--
ABOUTME: Design + spec for automatic recording lifecycle and semantic transcript search.
ABOUTME: Covers mic-activity auto-start/stop, calendar metadata, and seren-embed search.
-->

# Auto-record lifecycle + semantic transcript search — design & spec

_Design review 2026-06-26. Issues: #2670 (auto-record lifecycle), #2659 (calendar metadata + pre-arm), #2658 (semantic search). #2660 (action-item lifecycle) is explicitly out of scope._

## Motivation

Recording is **passive** today: `audio/detect.rs` probes mic activity and pops a manual "Call detected" prompt; the user must remember to start *and* stop. A real user forgot to stop and left a **209-minute** recording running after the calls closed. We make recording start automatically when a meeting app takes the mic and stop automatically when it's released, and we make transcripts searchable.

## Decisions (locked)

| Area | Decision |
| --- | --- |
| Auto-start gate | Rising edge of *(mic `input_active` AND a `KNOWN_CALL_APPS` process running)*, ~3s debounce. Manual prompt stays as fallback. |
| Auto-stop | Multi-signal, earliest of: app-release sustained **90s**; **15 min** no new transcript; matched calendar `scheduled_end + 5 min`. |
| Start UX | Silent start + loud indicator (tray/menubar + draggable floating pill + in-app banner), one-click Stop + Delete. |
| Delete | Reuse existing `delete_meeting_record` cascade. No new delete code. |
| Pause/Resume | Net-new pipeline capability + indicator controls; marks transcript `Gap`. |
| Calendar | Google Calendar (read-only publisher) — metadata match + pre-arm. Outlook/Exchange + Zoom = fast-follow (no publisher today; Zoom/Meet events ride the user's Google calendar). |
| Search engine | Semantic via existing `seren-embed` + `sqlite-vec` (reuse code-search infra). `LIKE` exact-match pass alongside / offline fallback. Requires connectivity (relaxes #2658's original offline criterion). |
| Default | Auto-record **ON**; Settings toggle + editable app list. |
| Consent v1 | First-run explainer + copyable disclosure snippet. Auto-post-to-chat = fast-follow. |

## Architecture

Both features attach to the existing capture/transcript subsystem; neither rebuilds it.

### Auto-record engine (`src-tauri/src/audio/lifecycle.rs`)
State machine `Idle → Armed → Recording → Stopping → Stopped`, driven by a ~2s poll of `probe_audio_activity()` plus last-transcript-segment time and (optional) calendar windows. Calls the existing `start_meeting_capture` / `stop_meeting_capture`; emits lifecycle events to the frontend. Never touches the capture pipeline internals.

- **Start:** debounced rising edge of the gate.
- **Stop:** multi-signal; if a stop signal reverses inside its grace window, cancel and return to `Recording`.
- **Manual-stop suppression:** a manual Stop disarms auto-start until the next `Idle` transition (so a still-live call can't instantly re-record).
- **Merge prevention:** each `Recording` cycle is its own meeting record; a stop is a hard boundary, never appended.
- **Pre-arm:** ~1–2 min before a matched calendar event, enter `Armed` and pre-warm the device; disarm ~15 min after scheduled start if no mic activity.

### Pause/Resume
New `pause_meeting_capture` / `resume_meeting_capture` commands suspend/resume frame ingestion without ending the session; the gap is recorded via the existing `Gap` segment status; the elapsed timer pauses.

### Calendar (`src/services/calendar.ts`)
One-time Google Calendar connect (OAuth passthrough) → `events.list` windowed, polled ~5 min, cached locally. On auto-start, match the concurrent event (time overlap + meeting link/app) and stamp `title`, `attendees_json`, `calendar_event_id` onto the meeting. Pure enrichment — everything works if unconnected.

### Search
On capture-complete, chunk the transcript into overlapping windows of consecutive segments (~3–6 turns / ≤~512 tokens, speaker-aware), embed via `seren-embed` (text-embedding-3-small, 1536-dim) into a new local-only `transcript_embeddings` vec0 table; also embed notes. Backfill existing meetings. Query = semantic `search_similar` merged with a `LIKE` sweep over transcript text + titles + attendees; rank = semantic + exact-match boost. Surfaces: ⌘K palette, library search field, in-transcript find. Results: snippet + surrounding turns + speaker labels + jump-to-source; filters by speaker / date / attendee.

## Data model

- `meetings` += `trigger_source` (`manual｜auto_mic｜calendar`), `calendar_event_id`, `calendar_provider`, `attendees_json`. One rusqlite migration; cloud mirror rides existing `payload jsonb`.
- New local-only `transcript_embeddings` vec0 (`chunk_id, meeting_id, seq_start, seq_end, vector[1536]`) — derived, not synced.
- `transcript_segments` unchanged; Pause writes a `Gap` segment.
- Settings (`tauri-plugin-store`): `auto_record_enabled=true`, editable known-call-app list, calendar connection, consent prefs.

## Privacy

Raw audio is never persisted (existing design) — only transcripts. ON-by-default is covered by the loud indicator + first-run consent explainer; Delete is one-click and tombstones the synced copy. Attendee PII stays local + synced as meeting metadata and is scrubbed from error reports. Two-party-consent exposure flagged; v1 = explainer + copyable snippet.

## Implementation plan

Each phase = worktree → PR(s) → merge → cleanup. Critical-path tests only (no TDD, no duplicate tests).

- **Phase 0** — verify transcript persistence end-to-end (search depends on it).
- **Phase 1** — auto-record lifecycle (`lifecycle.rs` + settings + quit/sleep guard + pause/resume). [#2670]
- **Phase 2** — recording indicator UI (tray/pill/banner + first-run consent).
- **Phase 3** — calendar metadata + pre-arm. [#2659]
- **Phase 4** — semantic search. [#2658]

Order: 0 → 1 → 2, then 3 and 4 in parallel. Phase 1 alone kills the runaway.

## Post-implementation

Functional walk-through audit (macOS + Windows via AWS SSM for build/detection/logic; live-audio behavior flagged where only a human on a real call can confirm). New P0/P1 findings → tickets assigned to `taariq`, labeled bug, fixed via the same workflow; loop until green.
