// ABOUTME: Chat model worker adapter that calls the Seren Gateway API.
// ABOUTME: Streams SSE responses and translates them into WorkerEvent types.

use async_trait::async_trait;
use futures::StreamExt;
use log;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc};

use super::types::{ImageAttachment, RoutingDecision, WorkerEvent};
use super::worker::Worker;

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const PUBLISHER_SLUG: &str = "seren-models";

/// Chat model worker that routes through the Seren Gateway API.
pub struct ChatModelWorker {
    client: reqwest::Client,
    /// Cancellation flag shared with the streaming loop.
    cancelled: Arc<Mutex<bool>>,
}

/// Connect timeout for the HTTP client (seconds).
const CONNECT_TIMEOUT_SECS: u64 = 30;

impl ChatModelWorker {
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

    /// Build the request body for the Gateway API.
    fn build_request_body(
        &self,
        prompt: &str,
        conversation_context: &[serde_json::Value],
        routing: &RoutingDecision,
        skill_content: &str,
        tools: &[serde_json::Value],
        images: &[ImageAttachment],
    ) -> serde_json::Value {
        let mut messages: Vec<serde_json::Value> = Vec::new();

        // System prompt with optional skill content
        let system_content = if skill_content.is_empty() {
            "You are a helpful AI assistant.".to_string()
        } else {
            format!("You are a helpful AI assistant.\n\n{}", skill_content)
        };
        messages.push(serde_json::json!({
            "role": "system",
            "content": system_content
        }));

        // Conversation history
        for msg in conversation_context {
            messages.push(msg.clone());
        }

        // Current user prompt — multimodal when images are present
        if images.is_empty() {
            messages.push(serde_json::json!({
                "role": "user",
                "content": prompt
            }));
        } else {
            let mut content_parts: Vec<serde_json::Value> = Vec::new();
            content_parts.push(serde_json::json!({
                "type": "text",
                "text": prompt
            }));
            for image in images {
                content_parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", image.mime_type, image.base64)
                    }
                }));
            }
            messages.push(serde_json::json!({
                "role": "user",
                "content": content_parts
            }));
        }

        let mut body = serde_json::json!({
            "model": routing.model_id,
            "messages": messages,
            "stream": true
        });

        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
            body["tool_choice"] = serde_json::json!("auto");
        }

        body
    }

    /// Extract text from a content value that may be a string, an array of parts,
    /// or an object with a "text" field (Gemini returns array-of-parts format).
    fn normalize_content(value: &serde_json::Value) -> Option<String> {
        if let Some(s) = value.as_str() {
            return if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            };
        }

        if let Some(arr) = value.as_array() {
            let combined: String = arr
                .iter()
                .filter_map(|piece| {
                    piece.as_str().map(|s| s.to_string()).or_else(|| {
                        piece
                            .get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    })
                })
                .collect::<Vec<_>>()
                .join("");
            return if combined.is_empty() {
                None
            } else {
                Some(combined)
            };
        }

        if let Some(text) = value.get("text").and_then(|t| t.as_str()) {
            return if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            };
        }

        None
    }

    /// Parse a single SSE data line into WorkerEvents and optional cost.
    ///
    /// Returns `(events, cost)` where cost is extracted from the Gateway wrapper's
    /// `"cost"` field (e.g. `{"status":200,"body":{...},"cost":"0.003"}`).
    fn parse_sse_data(data: &str) -> (Vec<WorkerEvent>, Option<f64>) {
        let parsed: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => {
                log::debug!(
                    "[ChatModelWorker] Non-JSON SSE data: {}",
                    &data[..data.len().min(200)]
                );
                return (Vec::new(), None);
            }
        };

        log::debug!(
            "[ChatModelWorker] SSE chunk: {}",
            &data[..data.len().min(300)]
        );

        let mut events = Vec::new();

        // Extract cost from Gateway wrapper (present at top level)
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
                    .unwrap_or("Gateway API error");
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

        // Extract content delta (handles string, array-of-parts, or object with "text")
        let content_value = effective
            .pointer("/delta/content")
            .or_else(|| effective.pointer("/choices/0/delta/content"));

        let content_text = content_value.and_then(Self::normalize_content);

        if let Some(ref text) = content_text {
            events.push(WorkerEvent::Content { text: text.clone() });
        }

        // Extract thinking delta (Anthropic extended thinking)
        let thinking = effective
            .pointer("/delta/thinking")
            .or_else(|| effective.pointer("/choices/0/delta/thinking"))
            .and_then(|v| v.as_str());

        if let Some(text) = thinking {
            if !text.is_empty() {
                events.push(WorkerEvent::Thinking {
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

        // Check for finish_reason (check both wrapped and unwrapped paths)
        let finish_reason = effective
            .pointer("/choices/0/finish_reason")
            .and_then(|v| v.as_str());

        if let Some("stop") = finish_reason {
            let final_content = content_text.clone().unwrap_or_default();
            events.push(WorkerEvent::Complete {
                final_content,
                thinking: None,
                cost: None, // Cost set by stream_response from accumulated total
            });
        }

        // Log when no events were extracted (helps debug format issues)
        if events.is_empty() {
            log::debug!(
                "[ChatModelWorker] No events extracted from SSE data: {}",
                &data[..data.len().min(300)]
            );
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
        let mut accumulated_thinking = String::new();
        let mut accumulated_cost: f64 = 0.0;
        let mut got_complete = false;

        let mut chunk_count = 0u32;

        while let Some(chunk_result) = stream.next().await {
            // Check cancellation
            if *self.cancelled.lock().await {
                return Ok(());
            }

            let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
            let text = String::from_utf8_lossy(&chunk);
            chunk_count += 1;

            // Log first few chunks to diagnose format issues
            if chunk_count <= 3 {
                log::info!(
                    "[ChatModelWorker] Chunk #{} ({} bytes): {}",
                    chunk_count,
                    chunk.len(),
                    &text[..text.len().min(500)]
                );
            }

            buffer.push_str(&text);

            // Process complete lines
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                // Handle both "data: " (with space) and "data:" (without space)
                let data_opt = line
                    .strip_prefix("data: ")
                    .or_else(|| line.strip_prefix("data:"));

                // Extract SSE data payload, or try raw JSON as fallback
                let data_str = if let Some(data) = data_opt {
                    data.to_string()
                } else if line.starts_with('{') {
                    // Fallback: raw JSON line without SSE data: prefix (NDJSON)
                    log::debug!(
                        "[ChatModelWorker] Raw JSON line (no data: prefix): {}",
                        &line[..line.len().min(200)]
                    );
                    line.clone()
                } else {
                    log::debug!(
                        "[ChatModelWorker] Skipping unrecognized SSE line: {}",
                        &line[..line.len().min(200)]
                    );
                    continue;
                };

                if data_str.trim() == "[DONE]" {
                    if !got_complete {
                        let thinking = if accumulated_thinking.is_empty() {
                            None
                        } else {
                            Some(accumulated_thinking.clone())
                        };
                        let cost = if accumulated_cost > 0.0 {
                            Some(accumulated_cost)
                        } else {
                            None
                        };
                        log::debug!(
                            "[ChatModelWorker] Stream complete — accumulated_cost={}, sending cost={:?}",
                            accumulated_cost,
                            cost
                        );
                        event_tx
                            .send(WorkerEvent::Complete {
                                final_content: accumulated_content.clone(),
                                thinking,
                                cost,
                            })
                            .await
                            .map_err(|e| format!("Failed to send Complete event: {}", e))?;
                    }
                    return Ok(());
                }

                let (events, chunk_cost) = Self::parse_sse_data(&data_str);
                if let Some(c) = chunk_cost {
                    accumulated_cost += c;
                }
                for event in events {
                    match &event {
                        WorkerEvent::Content { text } => {
                            accumulated_content.push_str(text);
                        }
                        WorkerEvent::Thinking { text } => {
                            accumulated_thinking.push_str(text);
                        }
                        WorkerEvent::Complete { .. } => {
                            got_complete = true;
                            let thinking = if accumulated_thinking.is_empty() {
                                None
                            } else {
                                Some(accumulated_thinking.clone())
                            };
                            let cost = if accumulated_cost > 0.0 {
                                Some(accumulated_cost)
                            } else {
                                None
                            };
                            event_tx
                                .send(WorkerEvent::Complete {
                                    final_content: accumulated_content.clone(),
                                    thinking,
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

        // Log stream summary for debugging
        log::info!(
            "[ChatModelWorker] Stream ended: {} chunks received, {} bytes remaining in buffer, accumulated {} content bytes",
            chunk_count,
            buffer.len(),
            accumulated_content.len()
        );

        // Handle Gateway non-streaming wrapper format:
        // The Gateway may return the entire response as a single JSON blob where
        // the body field is a string containing embedded SSE data:
        //   {"status":200,"body":"data: {...}\n\ndata: {...}\n\n...[DONE]","cost":"..."}
        // In this case the buffer has no real newlines (SSE newlines are JSON escapes).
        if !buffer.is_empty() && accumulated_content.is_empty() && !got_complete {
            if let Ok(wrapper) = serde_json::from_str::<serde_json::Value>(&buffer) {
                // Extract cost from the non-streaming wrapper
                if let Some(wrapper_cost) = wrapper.get("cost").and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse::<f64>().ok())
                        .or_else(|| v.as_f64())
                }) {
                    log::info!("[ChatModelWorker] Gateway reported cost: {}", wrapper_cost);
                    accumulated_cost += wrapper_cost;
                }

                if let Some(body_str) = wrapper.get("body").and_then(|b| b.as_str()) {
                    log::info!(
                        "[ChatModelWorker] Gateway returned non-streaming wrapper, extracting embedded SSE ({} bytes)",
                        body_str.len()
                    );
                    // Process the embedded SSE content
                    for raw_line in body_str.split('\n') {
                        let line = raw_line.trim();
                        if line.is_empty() || line.starts_with(':') {
                            continue;
                        }
                        let data = line
                            .strip_prefix("data: ")
                            .or_else(|| line.strip_prefix("data:"));
                        let data_str = if let Some(d) = data {
                            d
                        } else if line.starts_with('{') {
                            line
                        } else {
                            continue;
                        };
                        if data_str.trim() == "[DONE]" {
                            break;
                        }
                        let (events, chunk_cost) = Self::parse_sse_data(data_str);
                        if let Some(c) = chunk_cost {
                            accumulated_cost += c;
                        }
                        for event in events {
                            match &event {
                                WorkerEvent::Content { text } => {
                                    accumulated_content.push_str(text);
                                }
                                WorkerEvent::Thinking { text } => {
                                    accumulated_thinking.push_str(text);
                                }
                                WorkerEvent::Complete { .. } => {
                                    got_complete = true;
                                }
                                _ => {}
                            }
                            event_tx
                                .send(event)
                                .await
                                .map_err(|e| format!("Failed to send event: {}", e))?;
                        }
                    }
                } else if let Some(body_obj) = wrapper.get("body") {
                    // body is a JSON object (non-streaming response), extract content directly
                    if body_obj.is_object() {
                        log::info!("[ChatModelWorker] Gateway returned non-streaming JSON body");
                        let (events, chunk_cost) = Self::parse_sse_data(&body_obj.to_string());
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
        }

        // If stream ended without [DONE], send a Complete
        if !got_complete {
            let thinking = if accumulated_thinking.is_empty() {
                None
            } else {
                Some(accumulated_thinking)
            };
            let cost = if accumulated_cost > 0.0 {
                Some(accumulated_cost)
            } else {
                None
            };
            log::debug!(
                "[ChatModelWorker] Final complete — accumulated_cost={}, sending cost={:?}",
                accumulated_cost,
                cost
            );
            event_tx
                .send(WorkerEvent::Complete {
                    final_content: accumulated_content,
                    thinking,
                    cost,
                })
                .await
                .map_err(|e| format!("Failed to send final Complete event: {}", e))?;
        }

        Ok(())
    }
}

#[async_trait]
impl Worker for ChatModelWorker {
    fn id(&self) -> &str {
        "chat_model"
    }

    async fn execute(
        &self,
        prompt: &str,
        conversation_context: &[serde_json::Value],
        routing: &RoutingDecision,
        skill_content: &str,
        app: &tauri::AppHandle,
        images: &[ImageAttachment],
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        // Reset cancellation flag
        *self.cancelled.lock().await = false;

        log::info!(
            "[ChatModelWorker] Executing with model: {}",
            routing.model_id
        );
        log::debug!(
            "[ChatModelWorker] Prompt preview: {}",
            &prompt[..prompt.len().min(50)]
        );

        // Build request
        let url = format!(
            "{}/publishers/{}/chat/completions",
            GATEWAY_BASE_URL, PUBLISHER_SLUG
        );
        // TODO: ChatModel worker doesn't pass tools to the LLM yet. The frontend
        // sends tool names in capabilities.available_tools, but this worker needs
        // full tool definitions (name, description, parameters schema). To fix this,
        // the frontend should send complete tool definitions, or the orchestrator
        // should resolve definitions from names. For now, tool-requiring requests
        // are routed to McpPublisher or AcpAgent workers instead.
        let tools: Vec<serde_json::Value> = Vec::new();
        let body = self.build_request_body(
            prompt,
            conversation_context,
            routing,
            skill_content,
            &tools,
            images,
        );
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
            log::error!("[ChatModelWorker] HTTP {} from Gateway", status);
            event_tx
                .send(WorkerEvent::Error {
                    message: format!("Gateway returned HTTP {}", status),
                })
                .await
                .map_err(|e| format!("Failed to send error event: {}", e))?;
            return Err(format!(
                "Gateway returned HTTP {}: {}",
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

/// Request body for the Gateway chat completions endpoint.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<serde_json::Value>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_correct_request_body() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
        };

        let body = worker.build_request_body(
            "Hello world",
            &[serde_json::json!({"role": "user", "content": "previous message"})],
            &routing,
            "",
            &[],
            &[],
        );

        assert_eq!(body["model"], "anthropic/claude-sonnet-4");
        assert_eq!(body["stream"], true);
        let messages = body["messages"].as_array().unwrap();
        // system + 1 history + current user = 3
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["content"], "previous message");
        assert_eq!(messages[2]["content"], "Hello world");
    }

    #[test]
    fn builds_request_with_skill_content() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
        };

        let body = worker.build_request_body(
            "Hello",
            &[],
            &routing,
            "# Active Skills\n\n## Skill: Prose",
            &[],
            &[],
        );

        let system_msg = body["messages"][0]["content"].as_str().unwrap();
        assert!(system_msg.contains("Active Skills"));
        assert!(system_msg.contains("Prose"));
    }

    #[test]
    fn builds_request_with_tools() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "Research".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
        };

        let tools = vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web",
                "parameters": {"type": "object", "properties": {}}
            }
        })];

        let body = worker.build_request_body("Search for news", &[], &routing, "", &tools, &[]);

        assert!(body.get("tools").is_some());
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn parses_content_sse_data() {
        let data = r#"{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Hello"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_content_from_delta_shorthand() {
        let data = r#"{"delta":{"content":"World"}}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "World"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_tool_call_sse_data() {
        let data = r#"{"choices":[{"delta":{"tool_calls":[{"id":"tc_1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"news\"}"}}]},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::ToolCall {
                tool_call_id,
                name,
                arguments,
                title,
            } => {
                assert_eq!(tool_call_id, "tc_1");
                assert_eq!(name, "web_search");
                assert!(arguments.contains("news"));
                assert_eq!(title, "web_search");
            }
            _ => panic!("Expected ToolCall event"),
        }
    }

    #[test]
    fn parses_finish_stop_as_complete() {
        let data = r#"{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, WorkerEvent::Complete { .. }))
        );
    }

    #[test]
    fn parses_gateway_error_response() {
        let data =
            r#"{"status":402,"body":{"error":{"message":"Insufficient credits"}},"cost":"0"}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Error { message } => {
                assert!(message.contains("402"));
                assert!(message.contains("Insufficient credits"));
            }
            _ => panic!("Expected Error event"),
        }
    }

    #[test]
    fn ignores_invalid_json() {
        let (events, cost) = ChatModelWorker::parse_sse_data("not json at all");
        assert!(events.is_empty());
        assert!(cost.is_none());
    }

    #[test]
    fn ignores_empty_content() {
        let data = r#"{"choices":[{"delta":{"content":""},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        // Should not produce a Content event for empty string
        assert!(
            events
                .iter()
                .all(|e| !matches!(e, WorkerEvent::Content { .. }))
        );
    }

    #[test]
    fn parses_thinking_sse_data() {
        let data = r#"{"delta":{"thinking":"Let me consider..."}}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Thinking { text } => assert_eq!(text, "Let me consider..."),
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn parses_thinking_from_choices_path() {
        let data = r#"{"choices":[{"delta":{"thinking":"Reasoning step"},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Thinking { text } => assert_eq!(text, "Reasoning step"),
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn ignores_empty_thinking() {
        let data = r#"{"choices":[{"delta":{"thinking":""},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert!(
            events
                .iter()
                .all(|e| !matches!(e, WorkerEvent::Thinking { .. }))
        );
    }

    #[test]
    fn builds_request_with_images() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
        };

        let images = vec![ImageAttachment {
            name: "screenshot.png".to_string(),
            mime_type: "image/png".to_string(),
            base64: "iVBORw0KGgo=".to_string(),
        }];

        let body =
            worker.build_request_body("What is in this image?", &[], &routing, "", &[], &images);

        let messages = body["messages"].as_array().unwrap();
        let user_msg = &messages[messages.len() - 1];
        assert_eq!(user_msg["role"], "user");
        // Should be multimodal content array
        let content = user_msg["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "What is in this image?");
        assert_eq!(content[1]["type"], "image_url");
        assert!(
            content[1]["image_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
    }

    #[test]
    fn parses_gemini_array_of_parts_content() {
        // Gemini returns content as an array of objects with "text" fields
        let data = r#"{"choices":[{"delta":{"content":[{"text":"Hello from Gemini"}]},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Hello from Gemini"),
            _ => panic!("Expected Content event, got {:?}", events[0]),
        }
    }

    #[test]
    fn parses_gemini_multi_part_content() {
        // Multiple parts concatenated
        let data = r#"{"choices":[{"delta":{"content":[{"text":"Hello "},{"text":"world"}]},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Hello world"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_gemini_object_with_text_content() {
        // Content as a single object with "text" field
        let data =
            r#"{"choices":[{"delta":{"content":{"text":"Object content"}},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Object content"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn ignores_empty_gemini_array_content() {
        let data = r#"{"choices":[{"delta":{"content":[]},"finish_reason":null}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert!(
            events
                .iter()
                .all(|e| !matches!(e, WorkerEvent::Content { .. }))
        );
    }

    #[test]
    fn parses_gemini_finish_with_array_content() {
        // Finish with array-of-parts content should include the content in Complete
        let data =
            r#"{"choices":[{"delta":{"content":[{"text":"Done"}]},"finish_reason":"stop"}]}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, WorkerEvent::Content { text } if text == "Done"))
        );
        assert!(events.iter().any(
            |e| matches!(e, WorkerEvent::Complete { final_content, .. } if final_content == "Done")
        ));
    }

    #[test]
    fn parses_gateway_wrapped_content() {
        // Gateway wraps SSE events in {status, body, cost}
        let data = r#"{"status":200,"body":{"choices":[{"delta":{"content":"Wrapped hello"},"finish_reason":null}]},"cost":"0.001"}"#;
        let (events, cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Wrapped hello"),
            _ => panic!("Expected Content event, got {:?}", events[0]),
        }
        assert_eq!(cost, Some(0.001));
    }

    #[test]
    fn parses_gateway_wrapped_finish() {
        let data = r#"{"status":200,"body":{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]},"cost":"0.002"}"#;
        let (events, cost) = ChatModelWorker::parse_sse_data(data);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, WorkerEvent::Complete { .. }))
        );
        assert_eq!(cost, Some(0.002));
    }

    #[test]
    fn extracts_zero_cost_from_gateway() {
        let data = r#"{"status":200,"body":{"choices":[{"delta":{"content":"test"},"finish_reason":null}]},"cost":"0"}"#;
        let (_events, cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(cost, Some(0.0));
    }

    #[test]
    fn no_cost_when_absent_from_response() {
        let data = r#"{"choices":[{"delta":{"content":"no wrapper"},"finish_reason":null}]}"#;
        let (_events, cost) = ChatModelWorker::parse_sse_data(data);
        assert!(cost.is_none());
    }

    #[test]
    fn parses_gateway_wrapped_gemini_array_content() {
        // Gateway-wrapped Gemini array-of-parts format
        let data = r#"{"status":200,"body":{"choices":[{"delta":{"content":[{"text":"Wrapped Gemini"}]},"finish_reason":null}]},"cost":"0"}"#;
        let (events, _cost) = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Wrapped Gemini"),
            _ => panic!("Expected Content event, got {:?}", events[0]),
        }
    }
}
