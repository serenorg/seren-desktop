// ABOUTME: Auto-publishes a finalized meeting (notes + action items + transcript) to seren-notes.
// ABOUTME: Returns the created note UUID so the client can link "Chat with meeting notes".

use crate::auth::{authenticated_request, has_stored_credentials};
use reqwest::Client;
use serde_json::Value;
use tauri::AppHandle;

const PUBLISH_URL: &str = "https://api.serendb.com/publishers/seren-notes/notes";

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

/// POST the assembled note to seren-notes via the Gateway publisher proxy
/// using the user's existing access token. Short-circuits with a clear error
/// when no credentials are stored — callers handle that case by skipping the
/// publish silently and letting the UI render the "Login to SerenDB" CTA.
pub async fn publish_meeting_notes(
    app: &AppHandle,
    title: &str,
    content: &str,
) -> Result<String, String> {
    if !has_stored_credentials(app) {
        return Err("not authenticated".to_string());
    }
    let client = Client::new();
    let body = serde_json::json!({
        "title": title,
        "content": content,
        "format": "markdown",
    })
    .to_string();
    let response = authenticated_request(app, &client, |c, token| {
        c.post(PUBLISH_URL)
            .header("Content-Type", "application/json")
            .bearer_auth(token)
            .body(body.clone())
    })
    .await?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("seren-notes read body failed: {err}"))?;
    if !status.is_success() {
        return Err(format!("seren-notes publish returned {status}: {text}"));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|err| format!("seren-notes response was not JSON: {err}"))?;
    extract_note_id(&value).ok_or_else(|| "seren-notes response missing note id".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
