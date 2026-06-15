// ABOUTME: Auto-publishes a finalized meeting (notes + action items + transcript) to seren-notes.
// ABOUTME: Returns the created note UUID so the client can link "Chat with meeting notes".

use crate::auth::{authenticated_request, has_stored_credentials};
use reqwest::Client;
use serde_json::Value;
use std::future::Future;
use std::time::Duration;
use tauri::AppHandle;

const PUBLISH_URL: &str = "https://api.serendb.com/publishers/seren-notes/notes";
// seren-notes is scale-to-zero — the first 5xx on a cold publisher is almost
// always cold-start warm-up, not a real failure. Two retries with widening
// backoff (2s, then 4s) give the worker time to come up before we declare a
// real outage and route the user to the support pipeline. Keep this in sync
// with the `Publish to Seren Notes` button copy in MeetingDetail. #2343.
const RETRY_BACKOFFS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(4)];

/// Outcome of a publish attempt. Distinguishes a missing-credentials skip
/// (silent — UI shows the Login CTA) from a terminal server failure that
/// should be surfaced to the user and routed through the support pipeline
/// for a serenorg/seren-desktop bug ticket. #2343.
#[derive(Debug)]
pub enum PublishError {
    NotAuthenticated,
    /// The Gateway transport or upstream publisher returned a retryable
    /// cold-start/server status, or an upstream publisher returned a terminal
    /// error status inside the Gateway envelope. `status` is the real status
    /// code surfaced to the UI/support pipeline; `body` is truncated by the
    /// caller before going into telemetry.
    Server {
        status: u16,
        body: String,
    },
    /// Any other failure — network drop, malformed response, missing id.
    Other(String),
}

impl PublishError {
    pub fn into_message(self) -> String {
        match self {
            PublishError::NotAuthenticated => "not authenticated".to_string(),
            PublishError::Server { status, body } => {
                format!("seren-notes publish returned {status}: {body}")
            }
            PublishError::Other(msg) => msg,
        }
    }
}

/// Assemble the single markdown body posted to seren-notes. Always carries
/// notes, action items, and the per-speaker transcript, in that order, so the
/// published page mirrors what the user sees locally.
pub fn build_publish_content(
    notes_markdown: &str,
    action_items: &[String],
    transcript: &str,
) -> String {
    let mut out = String::new();
    out.push_str("## Notes\n\n");
    out.push_str(notes_markdown.trim());
    out.push_str("\n\n## Action items\n\n");
    if action_items.is_empty() {
        out.push_str("_None captured._\n");
    } else {
        for item in action_items {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                continue;
            }
            out.push_str("- ");
            out.push_str(trimmed);
            out.push('\n');
        }
    }
    out.push_str("\n## Transcript\n\n");
    out.push_str(transcript.trim());
    out.push('\n');
    out
}

/// Walk an arbitrary seren-notes response shape (raw, NoteDataResponse, or the
/// Gateway publisher-proxy envelope `{data:{status,body,cost}}` with a body
/// that may be JSON-encoded) and return the first UUID-shaped `id` found.
/// Mirrors `extractNoteId` in `src/lib/save-to-notes.ts` so both surfaces
/// tolerate the same envelope drift.
pub fn extract_note_id(value: &Value) -> Option<String> {
    let mut queue: Vec<Value> = vec![value.clone()];
    while let Some(node) = queue.pop() {
        match node {
            Value::String(s) => {
                if s.starts_with('{') || s.starts_with('[') {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&s) {
                        queue.push(parsed);
                    }
                }
            }
            Value::Object(map) => {
                if let Some(Value::String(id)) = map.get("id") {
                    if is_uuid(id) {
                        return Some(id.clone());
                    }
                }
                for v in map.into_iter().map(|(_, v)| v) {
                    queue.push(v);
                }
            }
            Value::Array(items) => {
                for v in items {
                    queue.push(v);
                }
            }
            _ => {}
        }
    }
    None
}

fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let expected = [8usize, 4, 4, 4, 12];
    if parts.len() != expected.len() {
        return false;
    }
    for (part, expected_len) in parts.iter().zip(expected.iter()) {
        if part.len() != *expected_len {
            return false;
        }
        if !part.chars().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
    }
    true
}

fn publisher_proxy_envelope(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    let Value::Object(map) = value else {
        return None;
    };
    if map.contains_key("status") && map.contains_key("body") {
        return Some(map);
    }
    match map.get("data") {
        Some(Value::Object(data)) if data.contains_key("status") && data.contains_key("body") => {
            Some(data)
        }
        _ => None,
    }
}

fn status_value_to_u16(value: &Value) -> Option<u16> {
    if let Some(status) = value.as_u64() {
        return u16::try_from(status).ok();
    }
    value.as_str()?.parse::<u16>().ok()
}

fn publisher_status(value: &Value) -> Option<u16> {
    publisher_proxy_envelope(value)
        .and_then(|envelope| envelope.get("status"))
        .and_then(status_value_to_u16)
}

fn publisher_body_text(value: &Value, fallback: &str) -> String {
    publisher_proxy_envelope(value)
        .and_then(|envelope| envelope.get("body"))
        .map(|body| {
            body.as_str()
                .map(String::from)
                .unwrap_or_else(|| body.to_string())
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn is_retryable_publish_status(status: u16) -> bool {
    status == 408 || (500..=599).contains(&status)
}

fn parse_publish_response_body(text: &str) -> Result<String, PublishError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|err| PublishError::Other(format!("seren-notes response was not JSON: {err}")))?;
    if let Some(status) = publisher_status(&value) {
        if status >= 400 {
            return Err(PublishError::Server {
                status,
                body: publisher_body_text(&value, text),
            });
        }
    }
    extract_note_id(&value)
        .ok_or_else(|| PublishError::Other("seren-notes response missing note id".to_string()))
}

/// POST the assembled note to seren-notes via the Gateway publisher proxy
/// using the user's existing access token. Short-circuits with a clear error
/// when no credentials are stored — callers handle that case by skipping the
/// publish silently and letting the UI render the "Login to SerenDB" CTA.
///
/// On a transport/inner 408 or 5xx the attempt is retried up to
/// `RETRY_BACKOFFS.len()` times with widening backoff to absorb scale-to-zero
/// cold starts. A retryable status surviving every retry returns
/// `PublishError::Server`, which the caller surfaces to the UI (toast +
/// republish CTA) and emits as a captureSupportError so the support pipeline
/// opens a serenorg/seren-desktop bug ticket. #2343.
pub async fn publish_meeting_notes(
    app: &AppHandle,
    title: &str,
    content: &str,
) -> Result<String, PublishError> {
    if !has_stored_credentials(app) {
        return Err(PublishError::NotAuthenticated);
    }
    let client = Client::new();
    let body = serde_json::json!({
        "title": title,
        "content": content,
        "format": "markdown",
    })
    .to_string();

    publish_with_retry(&RETRY_BACKOFFS, || attempt_publish(app, &client, &body)).await
}

async fn publish_with_retry<F, Fut>(
    backoffs: &[Duration],
    mut attempt_publish: F,
) -> Result<String, PublishError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<String, PublishError>>,
{
    let mut last_server: Option<(u16, String)> = None;
    let attempts = backoffs.len() + 1;
    for attempt in 0..attempts {
        match attempt_publish().await {
            Ok(id) => return Ok(id),
            Err(PublishError::Server { status, body: srv }) => {
                if !is_retryable_publish_status(status) {
                    return Err(PublishError::Server { status, body: srv });
                }
                last_server = Some((status, srv));
                if let Some(delay) = backoffs.get(attempt).copied() {
                    log::warn!(
                        "[meeting] seren-notes publish retryable status={status} (attempt {}/{attempts}); retrying in {:?} (cold-start expected)",
                        attempt + 1,
                        delay,
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            }
            Err(err) => return Err(err),
        }
    }
    let (status, body) = last_server
        .expect("retry loop only exits via Ok, non-Server Err, or after surfacing a Server status");
    Err(PublishError::Server { status, body })
}

async fn attempt_publish(
    app: &AppHandle,
    client: &Client,
    body: &str,
) -> Result<String, PublishError> {
    let response = authenticated_request(app, client, |c, token| {
        c.post(PUBLISH_URL)
            .header("Content-Type", "application/json")
            .bearer_auth(token)
            .body(body.to_string())
    })
    .await
    .map_err(PublishError::Other)?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| PublishError::Other(format!("seren-notes read body failed: {err}")))?;
    if status.as_u16() == 408 || status.is_server_error() {
        return Err(PublishError::Server {
            status: status.as_u16(),
            body: text,
        });
    }
    if !status.is_success() {
        return Err(PublishError::Other(format!(
            "seren-notes publish returned {status}: {text}"
        )));
    }
    parse_publish_response_body(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn build_publish_content_contains_all_three_sections_in_order() {
        let body = build_publish_content(
            "# Summary\nWe agreed on Q3 launch.",
            &["Send recap email".to_string(), "Book follow-up".to_string()],
            "Me: Let's ship.\nThem: Agreed.",
        );
        let notes_idx = body.find("## Notes").expect("notes header");
        let actions_idx = body.find("## Action items").expect("actions header");
        let transcript_idx = body.find("## Transcript").expect("transcript header");
        assert!(notes_idx < actions_idx);
        assert!(actions_idx < transcript_idx);
        assert!(body.contains("We agreed on Q3 launch."));
        assert!(body.contains("- Send recap email"));
        assert!(body.contains("- Book follow-up"));
        assert!(body.contains("Me: Let's ship."));
        assert!(body.contains("Them: Agreed."));
    }

    #[test]
    fn build_publish_content_renders_placeholder_when_no_action_items() {
        let body = build_publish_content("notes", &[], "transcript");
        assert!(body.contains("## Action items\n\n_None captured._"));
    }

    #[test]
    fn build_publish_content_skips_blank_action_items() {
        let body = build_publish_content(
            "notes",
            &["   ".to_string(), "Real item".to_string()],
            "transcript",
        );
        assert!(body.contains("- Real item"));
        assert!(!body.contains("- \n"));
    }

    #[test]
    fn extract_note_id_handles_raw_upstream_shape() {
        let value = json!({"id": "276a4660-e16b-4934-97c6-a1ade2426653", "title": "n"});
        assert_eq!(
            extract_note_id(&value).as_deref(),
            Some("276a4660-e16b-4934-97c6-a1ade2426653")
        );
    }

    #[test]
    fn extract_note_id_handles_note_data_response_shape() {
        let value = json!({"data": {"id": "276a4660-e16b-4934-97c6-a1ade2426653"}});
        assert_eq!(
            extract_note_id(&value).as_deref(),
            Some("276a4660-e16b-4934-97c6-a1ade2426653")
        );
    }

    #[test]
    fn extract_note_id_handles_publisher_proxy_with_parsed_body() {
        let value = json!({
            "data": {
                "status": 200,
                "body": {"data": {"id": "276a4660-e16b-4934-97c6-a1ade2426653"}},
                "cost": 0
            }
        });
        assert_eq!(
            extract_note_id(&value).as_deref(),
            Some("276a4660-e16b-4934-97c6-a1ade2426653")
        );
    }

    #[test]
    fn extract_note_id_handles_publisher_proxy_with_json_string_body() {
        let value = json!({
            "data": {
                "status": 200,
                "body": "{\"id\":\"276a4660-e16b-4934-97c6-a1ade2426653\"}"
            }
        });
        assert_eq!(
            extract_note_id(&value).as_deref(),
            Some("276a4660-e16b-4934-97c6-a1ade2426653")
        );
    }

    #[test]
    fn extract_note_id_rejects_non_uuid_id_field() {
        let value = json!({"id": "not-a-uuid", "data": {"id": "also-not"}});
        assert_eq!(extract_note_id(&value), None);
    }

    #[test]
    fn extract_note_id_returns_none_when_id_missing() {
        let value = json!({"data": {"title": "n", "content": "c"}});
        assert_eq!(extract_note_id(&value), None);
    }

    #[test]
    fn parse_publish_response_body_returns_server_for_inner_408() {
        let text = json!({
            "data": {
                "status": 408,
                "body": {"error": "publisher cold start timeout"},
                "cost": "0"
            }
        })
        .to_string();
        match parse_publish_response_body(&text) {
            Err(PublishError::Server { status, body }) => {
                assert_eq!(status, 408);
                assert!(body.contains("publisher cold start timeout"));
            }
            other => panic!("expected inner 408 server error, got {other:?}"),
        }
    }

    #[test]
    fn parse_publish_response_body_returns_server_for_inner_503() {
        let text = json!({
            "data": {
                "status": 503,
                "body": "upstream unavailable",
                "cost": "0"
            }
        })
        .to_string();
        match parse_publish_response_body(&text) {
            Err(PublishError::Server { status, body }) => {
                assert_eq!(status, 503);
                assert_eq!(body, "upstream unavailable");
            }
            other => panic!("expected inner 503 server error, got {other:?}"),
        }
    }

    #[test]
    fn parse_publish_response_body_extracts_note_id_for_2xx_envelope() {
        let text = json!({
            "data": {
                "status": 201,
                "body": {"data": {"id": "276a4660-e16b-4934-97c6-a1ade2426653"}},
                "cost": "0"
            }
        })
        .to_string();
        let note_id = parse_publish_response_body(&text).expect("2xx envelope note id");
        assert_eq!(note_id, "276a4660-e16b-4934-97c6-a1ade2426653");
    }

    #[tokio::test]
    async fn publish_with_retry_retries_full_budget_on_inner_408() {
        let backoffs = [Duration::ZERO; RETRY_BACKOFFS.len()];
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen_attempts = attempts.clone();
        let result = publish_with_retry(&backoffs, move || {
            let seen_attempts = seen_attempts.clone();
            async move {
                seen_attempts.fetch_add(1, Ordering::SeqCst);
                Err(PublishError::Server {
                    status: 408,
                    body: "publisher cold start timeout".to_string(),
                })
            }
        })
        .await;

        match result {
            Err(PublishError::Server { status, .. }) => assert_eq!(status, 408),
            other => panic!("expected exhausted inner 408 retries, got {other:?}"),
        }
        assert_eq!(attempts.load(Ordering::SeqCst), RETRY_BACKOFFS.len() + 1);
    }

    #[tokio::test]
    async fn publish_with_retry_does_not_retry_non_retryable_inner_4xx() {
        let backoffs = [Duration::ZERO; RETRY_BACKOFFS.len()];
        let attempts = Arc::new(AtomicUsize::new(0));
        let seen_attempts = attempts.clone();
        let result = publish_with_retry(&backoffs, move || {
            let seen_attempts = seen_attempts.clone();
            async move {
                seen_attempts.fetch_add(1, Ordering::SeqCst);
                Err(PublishError::Server {
                    status: 401,
                    body: "unauthorized".to_string(),
                })
            }
        })
        .await;

        match result {
            Err(PublishError::Server { status, body }) => {
                assert_eq!(status, 401);
                assert_eq!(body, "unauthorized");
            }
            other => panic!("expected terminal inner 401, got {other:?}"),
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    // The captureSupportError telemetry payload echoes the publish error's
    // message verbatim; this test pins the wire shape so a future refactor
    // can't quietly break the support pipeline's signature dedupe. #2343.
    #[test]
    fn publish_error_server_into_message_includes_status_for_support_signature() {
        let err = PublishError::Server {
            status: 503,
            body: "upstream cold start".to_string(),
        };
        let msg = err.into_message();
        assert!(msg.contains("503"), "expected status in message: {msg}");
        assert!(
            msg.contains("upstream cold start"),
            "expected body in message: {msg}"
        );
    }

    // Cold-start absorption requires *more than one* retry — a single retry
    // is not enough to reach a warm worker. Pin the minimum retry count so a
    // tuning revert can't quietly drop the budget back to one. #2343.
    #[test]
    fn retry_budget_is_at_least_two_attempts_for_cold_start() {
        assert!(
            RETRY_BACKOFFS.len() >= 2,
            "scale-to-zero seren-notes needs at least two retries before declaring a real outage; got {}",
            RETRY_BACKOFFS.len()
        );
    }
}
