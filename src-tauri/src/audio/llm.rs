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
const SEREN_MODELS_SUMMARIZATION_MODEL: &str = "anthropic/claude-haiku-4.5";

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
            let fallback_model = seren_models_fallback_model(&request.model);
            let fallback_system = request.system.clone();
            let fallback_prompt = request.prompt.clone();
            match complete_oneshot(
                app,
                ProviderOneShotRequest {
                    agent_type,
                    model,
                    system: request.system,
                    prompt: request.prompt,
                },
            )
            .await
            {
                Ok(content) => Ok(content),
                Err(err) if is_provider_fallback_error(&err) => {
                    log::warn!(
                        "[audio-llm] provider one-shot unavailable (auth/capacity); retrying via SerenModels fallback: {err}"
                    );
                    complete_via_seren_models(
                        app,
                        CompletionRequest {
                            model: fallback_model,
                            system: fallback_system,
                            prompt: fallback_prompt,
                        },
                    )
                    .await
                }
                Err(err) => Err(err),
            }
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
        if preferred == "lmstudio" {
            return Some(preferred.to_string());
        }
        if is_authenticated(preferred) {
            return Some(preferred.to_string());
        }
    }

    ["claude-code", "codex", "gemini", "lmstudio"]
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
    if normalized.starts_with("lmstudio/") || bare.starts_with("lmstudio-") {
        return Some("lmstudio");
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
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(AUTO_MODEL_ID) {
        return None;
    }

    let lower = trimmed.to_ascii_lowercase();
    if agent_type == "lmstudio" {
        if let Some((prefix, model)) = trimmed.split_once('/') {
            if prefix.eq_ignore_ascii_case("lmstudio") && !model.trim().is_empty() {
                return Some(model.trim().to_string());
            }
            return None;
        }
        return Some(trimmed.to_string());
    }

    if trimmed.contains('/') {
        return None;
    }

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
    let _ = requested_model;
    SEREN_MODELS_SUMMARIZATION_MODEL.to_string()
}

/// A provider one-shot error that should retry on the wallet-billed SerenModels
/// fallback instead of failing the prompt. Covers two classes:
/// the provider isn't authenticated, or the provider's subscription has no
/// remaining capacity (quota/rate-limit). A long meeting that exhausts the
/// user's Claude/Codex/Gemini subscription mid-pass must still produce notes,
/// and must not keep hammering a throttled subscription that also serves the
/// user's interactive chat. Non-capacity safety errors (e.g. a tool-call abort)
/// are deliberately excluded so they still fail closed. #2397.
fn is_provider_fallback_error(error: &str) -> bool {
    is_provider_auth_error(error) || is_provider_capacity_error(error)
}

fn is_provider_auth_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("authentication required")
        || lower.contains("auth required")
        || lower.contains("invalid api key")
        || lower.contains("login required")
        || lower.contains("not logged in")
        || lower.contains("please run /login")
}

/// Detect provider subscription quota/rate-limit/capacity exhaustion. The
/// underlying CLIs surface these as free-form strings, so match on the
/// substrings the major providers use for HTTP 429 / usage-limit conditions.
fn is_provider_capacity_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("ratelimit")
        || lower.contains("too many requests")
        || lower.contains("quota")
        || lower.contains("usage limit")
        || lower.contains("usage_limit")
        || lower.contains("insufficient_quota")
        || lower.contains("resource exhausted")
        || lower.contains("resource_exhausted")
        || lower.contains("overloaded")
        || lower.contains("capacity")
        || lower.contains("429")
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
    fn route_uses_summarization_model_for_auto_and_cli_ids_without_auth() {
        assert_eq!(
            resolve_completion_route_from_agents(&[], AUTO_MODEL_ID),
            CompletionRoute::SerenModels {
                model: SEREN_MODELS_SUMMARIZATION_MODEL.to_string(),
            }
        );
        assert_eq!(
            resolve_completion_route_from_agents(&[], "claude-opus-4-8"),
            CompletionRoute::SerenModels {
                model: SEREN_MODELS_SUMMARIZATION_MODEL.to_string(),
            }
        );
    }

    #[test]
    fn route_uses_summarization_model_for_catalog_ids_on_gateway_fallback() {
        assert_eq!(
            resolve_completion_route_from_agents(&[], "openai/gpt-5"),
            CompletionRoute::SerenModels {
                model: SEREN_MODELS_SUMMARIZATION_MODEL.to_string(),
            }
        );
        assert_eq!(
            resolve_completion_route_from_agents(&[], "anthropic/claude-opus-4.6"),
            CompletionRoute::SerenModels {
                model: SEREN_MODELS_SUMMARIZATION_MODEL.to_string(),
            }
        );
    }

    #[test]
    fn route_does_not_send_catalog_ids_to_local_agents() {
        let agents = vec![agent("codex", true)];
        assert_eq!(
            resolve_completion_route_from_agents(&agents, "openai/gpt-5"),
            CompletionRoute::ProviderAgent {
                agent_type: "codex".to_string(),
                model: None,
            }
        );
    }

    #[test]
    fn route_keeps_explicit_lmstudio_models_local() {
        assert_eq!(
            resolve_completion_route_from_agents(&[], "lmstudio/qwen2.5-coder-14b"),
            CompletionRoute::ProviderAgent {
                agent_type: "lmstudio".to_string(),
                model: Some("qwen2.5-coder-14b".to_string()),
            }
        );
    }

    #[test]
    fn provider_auth_error_detection_is_narrow() {
        assert!(is_provider_auth_error(
            "Agent authentication required. Run the login flow and try again."
        ));
        assert!(is_provider_auth_error("Invalid API key"));
        assert!(is_provider_auth_error("not logged in"));
        assert!(!is_provider_auth_error(
            "provider one-shot attempted a tool call; toolless completion aborted"
        ));
        assert!(!is_provider_auth_error(
            "Provider runtime socket closed before prompt completed."
        ));
    }

    #[test]
    fn provider_capacity_error_detection_covers_common_quota_shapes() {
        for error in [
            "Rate limit exceeded. Please try again later.",
            "429 Too Many Requests",
            "You have hit your usage limit for this model",
            "insufficient_quota: you exceeded your current quota",
            "RESOURCE_EXHAUSTED: Quota exceeded for gemini",
            "Anthropic API error: overloaded_error",
            "Server is at capacity, retry shortly",
        ] {
            assert!(
                is_provider_capacity_error(error),
                "expected capacity error: {error}"
            );
        }
    }

    #[test]
    fn provider_capacity_error_does_not_match_safety_or_transport_errors() {
        // A tool-call/permission abort is a non-capacity safety error and MUST
        // fail closed, never fall back. Transport closes are not capacity.
        assert!(!is_provider_capacity_error(
            "provider one-shot attempted a tool call; toolless completion aborted"
        ));
        assert!(!is_provider_capacity_error(
            "Provider runtime socket closed before prompt completed."
        ));
        assert!(!is_provider_capacity_error(
            "provider one-shot returned no content"
        ));
    }

    #[test]
    fn fallback_predicate_covers_auth_and_capacity_but_not_safety() {
        assert!(is_provider_fallback_error("not logged in"));
        assert!(is_provider_fallback_error("429 Too Many Requests"));
        assert!(is_provider_fallback_error("usage limit reached"));
        // Safety / transport failures fail closed (no SerenModels fallback).
        assert!(!is_provider_fallback_error(
            "provider one-shot attempted a tool call; toolless completion aborted"
        ));
        assert!(!is_provider_fallback_error(
            "Provider runtime socket closed before prompt completed."
        ));
    }
}
