// ABOUTME: MCP publisher worker that routes requests through Seren publisher endpoints.
// ABOUTME: Streams SSE responses from publishers like Firecrawl, Perplexity, etc.

use async_trait::async_trait;
use futures::StreamExt;
use log;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc};

use super::types::{ImageAttachment, RoutingDecision, WorkerEvent};
use super::worker::Worker;

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";

/// MCP publisher worker that routes through a Seren publisher endpoint.
pub struct McpPublisherWorker {
    client: reqwest::Client,
    cancelled: Arc<Mutex<bool>>,
}

/// Connect timeout for the HTTP client (seconds).
const CONNECT_TIMEOUT_SECS: u64 = 30;

impl McpPublisherWorker {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            cancelled: Arc::new(Mutex::new(false)),
        }
    }

    /// Build the request body for the publisher chat completions endpoint.
    fn build_request_body(
        &self,
        prompt: &str,
        conversation_context: &[serde_json::Value],
        routing: &RoutingDecision,
        skill_content: &str,
    ) -> serde_json::Value {
        let mut messages: Vec<serde_json::Value> = Vec::new();

        let system_content = if skill_content.is_empty() {
            "You are a helpful AI assistant.".to_string()
        } else {
            format!("You are a helpful AI assistant.\n\n{}", skill_content)
        };
        messages.push(serde_json::json!({
            "role": "system",
            "content": system_content
        }));

        for msg in conversation_context {
            messages.push(msg.clone());
        }

        messages.push(serde_json::json!({
            "role": "user",
            "content": prompt
        }));

        serde_json::json!({
            "model": routing.model_id,
            "messages": messages,
            "stream": true
        })
    }

    /// Parse a single SSE data line into WorkerEvents and optional cost.
    ///
    /// Uses the same parsing logic as ChatModelWorker since publisher endpoints
    /// return the same OpenAI-compatible streaming format.
    fn parse_sse_data(data: &str) -> (Vec<WorkerEvent>, Option<f64>) {
        let parsed: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return (Vec::new(), None),
        };

        let mut events = Vec::new();

        // Extract cost from Gateway wrapper
        let chunk_cost = parsed.get("cost").and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| v.as_f64())
        });

        // Check for wrapped error status from Gateway
        if let Some(status) = parsed.get("status").and_then(|s| s.as_u64()) {
            if status >= 400 {
                let error_msg = parsed
                    .pointer("/body/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Publisher API error");
                events.push(WorkerEvent::Error {
                    message: format!("HTTP {}: {}", status, error_msg),
                });
                return (events, chunk_cost);
            }
        }

        // If Gateway wraps the SSE event in {status, body, cost}, unwrap body
        let effective = if parsed.get("body").is_some() && parsed.get("status").is_some() {
            parsed.pointer("/body").unwrap_or(&parsed)
        } else {
            &parsed
        };

        // Extract content delta
        let content = effective
            .pointer("/delta/content")
            .or_else(|| effective.pointer("/choices/0/delta/content"))
            .and_then(|v| v.as_str());

        if let Some(text) = content {
            if !text.is_empty() {
                events.push(WorkerEvent::Content {
                    text: text.to_string(),
                });
            }
        }

        // Extract tool calls from delta
        if let Some(tool_calls) = effective
            .pointer("/delta/tool_calls")
            .or_else(|| effective.pointer("/choices/0/delta/tool_calls"))
            .and_then(|v| v.as_array())
        {
            for tc in tool_calls {
                let id = tc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = tc
                    .pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let arguments = tc
                    .pointer("/function/arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                if !id.is_empty() && !name.is_empty() {
                    events.push(WorkerEvent::ToolCall {
                        tool_call_id: id.clone(),
                        name: name.clone(),
                        arguments,
                        title: name,
                    });
                }
            }
        }

        // Check for finish_reason
        let finish_reason = effective
            .pointer("/choices/0/finish_reason")
            .and_then(|v| v.as_str());

        if let Some("stop") = finish_reason {
            let final_content = content.unwrap_or("").to_string();
            events.push(WorkerEvent::Complete {
                final_content,
                thinking: None,
                cost: None, // Cost set by stream_response from accumulated total
            });
        }

        (events, chunk_cost)
    }

    /// Stream SSE response and forward events.
    async fn stream_response(
        &self,
        response: reqwest::Response,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut accumulated_content = String::new();
        let mut accumulated_cost: f64 = 0.0;
        let mut got_complete = false;

        while let Some(chunk_result) = stream.next().await {
            if *self.cancelled.lock().await {
                return Ok(());
            }

            let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        if !got_complete {
                            let cost = if accumulated_cost > 0.0 {
                                Some(accumulated_cost)
                            } else {
                                None
                            };
                            event_tx
                                .send(WorkerEvent::Complete {
                                    final_content: accumulated_content.clone(),
                                    thinking: None,
                                    cost,
                                })
                                .await
                                .map_err(|e| format!("Failed to send Complete event: {}", e))?;
                        }
                        return Ok(());
                    }

                    let (events, chunk_cost) = Self::parse_sse_data(data);
                    if let Some(c) = chunk_cost {
                        accumulated_cost += c;
                    }
                    for event in events {
                        match &event {
                            WorkerEvent::Content { text } => {
                                accumulated_content.push_str(text);
                            }
                            WorkerEvent::Complete { .. } => {
                                got_complete = true;
                                let cost = if accumulated_cost > 0.0 {
                                    Some(accumulated_cost)
                                } else {
                                    None
                                };
                                event_tx
                                    .send(WorkerEvent::Complete {
                                        final_content: accumulated_content.clone(),
                                        thinking: None,
                                        cost,
                                    })
                                    .await
                                    .map_err(|e| format!("Failed to send Complete event: {}", e))?;
                                continue;
                            }
                            _ => {}
                        }
                        event_tx
                            .send(event)
                            .await
                            .map_err(|e| format!("Failed to send event: {}", e))?;
                    }
                }
            }
        }

        if !got_complete {
            let cost = if accumulated_cost > 0.0 {
                Some(accumulated_cost)
            } else {
                None
            };
            event_tx
                .send(WorkerEvent::Complete {
                    final_content: accumulated_content,
                    thinking: None,
                    cost,
                })
                .await
                .map_err(|e| format!("Failed to send final Complete event: {}", e))?;
        }

        Ok(())
    }
}

#[async_trait]
impl Worker for McpPublisherWorker {
    fn id(&self) -> &str {
        "mcp_publisher"
    }

    async fn execute(
        &self,
        prompt: &str,
        conversation_context: &[serde_json::Value],
        routing: &RoutingDecision,
        skill_content: &str,
        app: &tauri::AppHandle,
        _images: &[ImageAttachment],
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        *self.cancelled.lock().await = false;

        let publisher_slug = routing.publisher_slug.as_deref().ok_or_else(|| {
            "McpPublisher worker requires a publisher_slug in routing".to_string()
        })?;

        log::info!(
            "[McpPublisherWorker] Executing with publisher: {}, model: {}",
            publisher_slug,
            routing.model_id
        );

        let url = format!(
            "{}/publishers/{}/chat/completions",
            GATEWAY_BASE_URL, publisher_slug
        );
        let body = self.build_request_body(prompt, conversation_context, routing, skill_content);
        let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

        // Use authenticated_request for automatic 401 refresh and retry
        let response = crate::auth::authenticated_request(app, &self.client, |client, token| {
            client
                .post(&url)
                .header("Content-Type", "application/json")
                .bearer_auth(token)
                .body(body_str.clone())
        })
        .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            log::error!(
                "[McpPublisherWorker] HTTP {} from publisher {}",
                status,
                publisher_slug
            );
            event_tx
                .send(WorkerEvent::Error {
                    message: format!("Publisher returned HTTP {}", status),
                })
                .await
                .map_err(|e| format!("Failed to send error event: {}", e))?;
            return Err(format!(
                "Publisher returned HTTP {}: {}",
                status,
                &body_text[..body_text.len().min(200)]
            ));
        }

        self.stream_response(response, &event_tx).await
    }

    async fn cancel(&self) -> Result<(), String> {
        *self.cancelled.lock().await = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_routing(publisher_slug: Option<&str>) -> RoutingDecision {
        RoutingDecision {
            worker_type: super::super::types::WorkerType::McpPublisher,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "Working with publisher on research".to_string(),
            selected_skills: vec![],
            publisher_slug: publisher_slug.map(String::from),
        }
    }

    #[test]
    fn builds_correct_request_body() {
        let worker = McpPublisherWorker::new();
        let routing = make_routing(Some("firecrawl-serenai"));

        let body = worker.build_request_body(
            "Scrape this URL",
            &[serde_json::json!({"role": "user", "content": "previous"})],
            &routing,
            "",
        );

        assert_eq!(body["model"], "anthropic/claude-sonnet-4");
        assert_eq!(body["stream"], true);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[2]["content"], "Scrape this URL");
    }

    #[test]
    fn builds_request_with_skill_content() {
        let worker = McpPublisherWorker::new();
        let routing = make_routing(Some("perplexity-serenai"));

        let body = worker.build_request_body(
            "Search for AI news",
            &[],
            &routing,
            "# Active Skills\n\n## Skill: Research",
        );

        let system_msg = body["messages"][0]["content"].as_str().unwrap();
        assert!(system_msg.contains("Active Skills"));
        assert!(system_msg.contains("Research"));
    }

    #[test]
    fn parses_content_sse_data() {
        let data = r#"{"choices":[{"delta":{"content":"Result"},"finish_reason":null}]}"#;
        let (events, _cost) = McpPublisherWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Result"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_publisher_error_response() {
        let data = r#"{"status":429,"body":{"error":{"message":"Rate limited"}},"cost":"0"}"#;
        let (events, _cost) = McpPublisherWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Error { message } => {
                assert!(message.contains("429"));
                assert!(message.contains("Rate limited"));
            }
            _ => panic!("Expected Error event"),
        }
    }

    #[test]
    fn parses_finish_stop_as_complete() {
        let data = r#"{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}"#;
        let (events, _cost) = McpPublisherWorker::parse_sse_data(data);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, WorkerEvent::Complete { .. }))
        );
    }

    #[test]
    fn parses_tool_call_from_publisher() {
        let data = r#"{"choices":[{"delta":{"tool_calls":[{"id":"tc_pub","type":"function","function":{"name":"scrape","arguments":"{\"url\":\"https://example.com\"}"}}]},"finish_reason":null}]}"#;
        let (events, _cost) = McpPublisherWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::ToolCall {
                tool_call_id, name, ..
            } => {
                assert_eq!(tool_call_id, "tc_pub");
                assert_eq!(name, "scrape");
            }
            _ => panic!("Expected ToolCall event"),
        }
    }

    #[test]
    fn ignores_invalid_json() {
        let (events, _cost) = McpPublisherWorker::parse_sse_data("not json");
        assert!(events.is_empty());
    }
}
