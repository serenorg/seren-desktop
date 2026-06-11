// ABOUTME: Single-shot chat completion via the Seren Gateway (no streaming).
// ABOUTME: One prompt -> one text using the user's selected model; shared by notes + dictation.

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::orchestrator::gateway_envelope::{publisher_status, unwrap_publisher_body};

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const PUBLISHER_SLUG: &str = "seren-models";

/// A single chat-completion request routed through the user's selected model.
pub struct CompletionRequest {
    pub model: String,
    pub system: Option<String>,
    pub prompt: String,
}

/// One bounded retry when the upstream returns HTTP 200 with empty content.
/// Most empty completions are transient upstream blips (timeout-as-empty,
/// post-filter blanking, max-tokens edge cases on one chunk's specific text)
/// that recover on a second try. Cap at one retry so we don't amplify load
/// when an upstream is genuinely degraded. #2366.
const COMPLETION_MAX_ATTEMPTS: u32 = 2;

/// Run one prompt through the same Gateway chat path the app uses for chat and
/// return the assistant's text. Non-streaming; reuses the authed Gateway bridge.
pub async fn complete(app: &AppHandle, request: CompletionRequest) -> Result<String, String> {
    if request.model.trim().is_empty() {
        return Err("no model selected for completion".to_string());
    }
    let client = reqwest::Client::new();
    let url = format!("{GATEWAY_BASE_URL}/publishers/{PUBLISHER_SLUG}/chat/completions");

    let mut messages = Vec::new();
    if let Some(system) = &request.system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": request.prompt }));
    let body = json!({
        "model": request.model,
        "messages": messages,
        "stream": false,
    })
    .to_string();

    for attempt in 1..=COMPLETION_MAX_ATTEMPTS {
        let url_for_attempt = url.clone();
        let body_for_attempt = body.clone();
        let response = crate::auth::authenticated_request(app, &client, move |client, token| {
            client
                .post(&url_for_attempt)
                .header("Content-Type", "application/json")
                .bearer_auth(token)
                .body(body_for_attempt.clone())
        })
        .await?;

        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(format!("chat completion http {status}: {detail}"));
        }

        let value: Value = response.json().await.map_err(|err| err.to_string())?;
        if let Some(status) = publisher_status(&value) {
            if status != 200 {
                let inner = unwrap_publisher_body(&value);
                let message = inner
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("upstream error");
                return Err(format!("chat completion upstream {status}: {message}"));
            }
        }

        let inner = unwrap_publisher_body(&value);
        let content = inner
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !content.trim().is_empty() {
            return Ok(content);
        }
        if attempt < COMPLETION_MAX_ATTEMPTS {
            log::warn!(
                "[meeting] empty chat completion on attempt {attempt}/{COMPLETION_MAX_ATTEMPTS}; retrying once"
            );
        }
    }
    Err("chat completion returned no content".to_string())
}
