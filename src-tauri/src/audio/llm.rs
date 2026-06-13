// ABOUTME: Single-shot chat completion via the Seren Gateway (no streaming).
// ABOUTME: One prompt -> one text using the user's selected model; shared by notes + dictation.

use serde_json::{Value, json};
use tauri::AppHandle;

use crate::orchestrator::gateway_envelope::{publisher_status, unwrap_publisher_body};
use crate::orchestrator::provider_worker::{
    ProviderAgentStatus, ProviderOneShotRequest, complete_oneshot, list_provider_agents,
};

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const PUBLISHER_SLUG: &str = "seren-models";
const AUTO_MODEL_ID: &str = "auto";
const DEFAULT_SEREN_MODELS_MODEL: &str = "anthropic/claude-sonnet-4";

/// A single chat-completion request routed through the user's selected model.
pub struct CompletionRequest {
    pub model: String,
    pub system: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionRoute {
    ProviderAgent {
        agent_type: String,
        model: Option<String>,
    },
    SerenModels {
        model: String,
    },
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
    if request.prompt.trim().is_empty() {
        return Err("completion prompt is empty".to_string());
    }

    match resolve_completion_route(app, &request.model).await {
        CompletionRoute::ProviderAgent { agent_type, model } => {
            complete_oneshot(
                app,
                ProviderOneShotRequest {
                    agent_type,
                    model,
                    system: request.system,
                    prompt: request.prompt,
                },
            )
            .await
        }
        CompletionRoute::SerenModels { model } => {
            complete_via_seren_models(
                app,
                CompletionRequest {
                    model,
                    system: request.system,
                    prompt: request.prompt,
                },
            )
            .await
        }
    }
}

async fn complete_via_seren_models(
    app: &AppHandle,
    request: CompletionRequest,
) -> Result<String, String> {
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

async fn resolve_completion_route(app: &AppHandle, requested_model: &str) -> CompletionRoute {
    match list_provider_agents(app).await {
        Ok(agents) => resolve_completion_route_from_agents(&agents, requested_model),
        Err(err) => {
            log::debug!(
                "[audio-llm] provider agent status unavailable; using SerenModels fallback: {err}"
            );
            CompletionRoute::SerenModels {
                model: seren_models_fallback_model(requested_model),
            }
        }
    }
}

pub fn resolve_completion_route_from_agents(
    agents: &[ProviderAgentStatus],
    requested_model: &str,
) -> CompletionRoute {
    if let Some(agent_type) = choose_authenticated_agent(agents, requested_model) {
        return CompletionRoute::ProviderAgent {
            model: agent_model_for_request(&agent_type, requested_model),
            agent_type,
        };
    }

    CompletionRoute::SerenModels {
        model: seren_models_fallback_model(requested_model),
    }
}

fn choose_authenticated_agent(
    agents: &[ProviderAgentStatus],
    requested_model: &str,
) -> Option<String> {
    let is_authenticated = |agent_type: &str| {
        agents
            .iter()
            .any(|agent| agent.agent_type == agent_type && agent.available && agent.authenticated)
    };

    if let Some(preferred) = preferred_agent_for_model(requested_model) {
        if is_authenticated(preferred) {
            return Some(preferred.to_string());
        }
    }

    ["claude-code", "codex", "gemini"]
        .into_iter()
        .find(|agent_type| is_authenticated(agent_type))
        .map(str::to_string)
}

fn preferred_agent_for_model(model: &str) -> Option<&'static str> {
    let normalized = model.trim().to_ascii_lowercase();
    let bare = normalized
        .split_once('/')
        .map(|(_, tail)| tail)
        .unwrap_or(normalized.as_str());
    if bare.starts_with("claude-") {
        return Some("claude-code");
    }
    if bare.starts_with("gemini-") {
        return Some("gemini");
    }
    if bare.starts_with("gpt-")
        || bare.starts_with("o1")
        || bare.starts_with("o3")
        || bare.starts_with("o4")
    {
        return Some("codex");
    }
    None
}

fn agent_model_for_request(agent_type: &str, requested_model: &str) -> Option<String> {
    let trimmed = requested_model.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(AUTO_MODEL_ID) || trimmed.contains('/') {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    let compatible = match agent_type {
        "claude-code" => lower.starts_with("claude-"),
        "codex" => {
            lower.starts_with("gpt-")
                || lower.starts_with("o1")
                || lower.starts_with("o3")
                || lower.starts_with("o4")
        }
        "gemini" => lower.starts_with("gemini-"),
        _ => false,
    };
    compatible.then(|| trimmed.to_string())
}

fn seren_models_fallback_model(requested_model: &str) -> String {
    let trimmed = requested_model.trim();
    if is_seren_models_catalog_id(trimmed) {
        trimmed.to_string()
    } else {
        DEFAULT_SEREN_MODELS_MODEL.to_string()
    }
}

fn is_seren_models_catalog_id(model: &str) -> bool {
    !model.is_empty() && !model.eq_ignore_ascii_case(AUTO_MODEL_ID) && model.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(agent_type: &str, authenticated: bool) -> ProviderAgentStatus {
        ProviderAgentStatus {
            agent_type: agent_type.to_string(),
            available: true,
            authenticated,
        }
    }

    #[test]
    fn route_prefers_authenticated_matching_cli_agent() {
        let agents = vec![agent("claude-code", true), agent("codex", true)];
        assert_eq!(
            resolve_completion_route_from_agents(&agents, "claude-opus-4-8"),
            CompletionRoute::ProviderAgent {
                agent_type: "claude-code".to_string(),
                model: Some("claude-opus-4-8".to_string()),
            }
        );
    }

    #[test]
    fn route_falls_back_to_catalog_model_for_auto_and_cli_ids_without_auth() {
        assert_eq!(
            resolve_completion_route_from_agents(&[], AUTO_MODEL_ID),
            CompletionRoute::SerenModels {
                model: DEFAULT_SEREN_MODELS_MODEL.to_string(),
            }
        );
        assert_eq!(
            resolve_completion_route_from_agents(&[], "claude-opus-4-8"),
            CompletionRoute::SerenModels {
                model: DEFAULT_SEREN_MODELS_MODEL.to_string(),
            }
        );
    }

    #[test]
    fn route_preserves_catalog_ids_only_on_gateway_fallback() {
        assert_eq!(
            resolve_completion_route_from_agents(&[], "openai/gpt-5"),
            CompletionRoute::SerenModels {
                model: "openai/gpt-5".to_string(),
            }
        );
        let agents = vec![agent("codex", true)];
        assert_eq!(
            resolve_completion_route_from_agents(&agents, "openai/gpt-5"),
            CompletionRoute::ProviderAgent {
                agent_type: "codex".to_string(),
                model: None,
            }
        );
    }
}
