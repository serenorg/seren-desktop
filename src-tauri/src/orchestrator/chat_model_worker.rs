// ABOUTME: Chat model worker adapter that calls the Seren Gateway API.
// ABOUTME: Streams SSE responses and translates them into WorkerEvent types.

use async_trait::async_trait;
use futures::StreamExt;
use log;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

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

impl ChatModelWorker {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
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

    /// Parse a single SSE data line into WorkerEvents.
    fn parse_sse_data(data: &str) -> Vec<WorkerEvent> {
        let parsed: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };

        let mut events = Vec::new();

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
                return events;
            }
        }

        // Extract content delta
        let content = parsed
            .pointer("/delta/content")
            .or_else(|| parsed.pointer("/choices/0/delta/content"))
            .and_then(|v| v.as_str());

        if let Some(text) = content {
            if !text.is_empty() {
                events.push(WorkerEvent::Content {
                    text: text.to_string(),
                });
            }
        }

        // Extract thinking delta (Anthropic extended thinking)
        let thinking = parsed
            .pointer("/delta/thinking")
            .or_else(|| parsed.pointer("/choices/0/delta/thinking"))
            .and_then(|v| v.as_str());

        if let Some(text) = thinking {
            if !text.is_empty() {
                events.push(WorkerEvent::Thinking {
                    text: text.to_string(),
                });
            }
        }

        // Extract tool calls from delta
        if let Some(tool_calls) = parsed
            .pointer("/delta/tool_calls")
            .or_else(|| parsed.pointer("/choices/0/delta/tool_calls"))
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
        let finish_reason = parsed
            .pointer("/choices/0/finish_reason")
            .and_then(|v| v.as_str());

        if let Some("stop") = finish_reason {
            let final_content = content.unwrap_or("").to_string();
            events.push(WorkerEvent::Complete {
                final_content,
                thinking: None,
            });
        }

        events
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
        let mut got_complete = false;

        while let Some(chunk_result) = stream.next().await {
            // Check cancellation
            if *self.cancelled.lock().await {
                return Ok(());
            }

            let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            // Process complete lines
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        if !got_complete {
                            let thinking = if accumulated_thinking.is_empty() {
                                None
                            } else {
                                Some(accumulated_thinking.clone())
                            };
                            event_tx
                                .send(WorkerEvent::Complete {
                                    final_content: accumulated_content.clone(),
                                    thinking,
                                })
                                .await
                                .map_err(|e| format!("Failed to send Complete event: {}", e))?;
                        }
                        return Ok(());
                    }

                    let events = Self::parse_sse_data(data);
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
                                event_tx
                                    .send(WorkerEvent::Complete {
                                        final_content: accumulated_content.clone(),
                                        thinking,
                                    })
                                    .await
                                    .map_err(|e| {
                                        format!("Failed to send Complete event: {}", e)
                                    })?;
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

        // If stream ended without [DONE], send a Complete
        if !got_complete {
            let thinking = if accumulated_thinking.is_empty() {
                None
            } else {
                Some(accumulated_thinking)
            };
            event_tx
                .send(WorkerEvent::Complete {
                    final_content: accumulated_content,
                    thinking,
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
        auth_token: &str,
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
        let tools: Vec<serde_json::Value> = Vec::new(); // Tools will be populated by the orchestrator
        let body = self.build_request_body(prompt, conversation_context, routing, skill_content, &tools, images);

        let response = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .bearer_auth(auth_token)
            .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .send()
            .await
            .map_err(|e| format!("Gateway API request failed: {}", e))?;

        if !response.status().is_success() {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            log::error!(
                "[ChatModelWorker] HTTP {} from Gateway",
                status
            );
            event_tx
                .send(WorkerEvent::Error {
                    message: format!("Gateway returned HTTP {}", status),
                })
                .await
                .map_err(|e| format!("Failed to send error event: {}", e))?;
            return Err(format!("Gateway returned HTTP {}: {}", status, &body_text[..body_text.len().min(200)]));
        }

        self.stream_response(response, &event_tx).await
    }

    async fn cancel(&self) -> Result<(), String> {
        *self.cancelled.lock().await = true;
        Ok(())
    }
}

/// Request body for the Gateway chat completions endpoint.
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

        let body = worker.build_request_body("Hello", &[], &routing, "# Active Skills\n\n## Skill: Prose", &[], &[]);

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
        let events = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Hello"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_content_from_delta_shorthand() {
        let data = r#"{"delta":{"content":"World"}}"#;
        let events = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "World"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_tool_call_sse_data() {
        let data = r#"{"choices":[{"delta":{"tool_calls":[{"id":"tc_1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"news\"}"}}]},"finish_reason":null}]}"#;
        let events = ChatModelWorker::parse_sse_data(data);
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
        let events = ChatModelWorker::parse_sse_data(data);
        assert!(events.iter().any(|e| matches!(e, WorkerEvent::Complete { .. })));
    }

    #[test]
    fn parses_gateway_error_response() {
        let data = r#"{"status":402,"body":{"error":{"message":"Insufficient credits"}},"cost":"0"}"#;
        let events = ChatModelWorker::parse_sse_data(data);
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
        let events = ChatModelWorker::parse_sse_data("not json at all");
        assert!(events.is_empty());
    }

    #[test]
    fn ignores_empty_content() {
        let data = r#"{"choices":[{"delta":{"content":""},"finish_reason":null}]}"#;
        let events = ChatModelWorker::parse_sse_data(data);
        // Should not produce a Content event for empty string
        assert!(events.iter().all(|e| !matches!(e, WorkerEvent::Content { .. })));
    }

    #[test]
    fn parses_thinking_sse_data() {
        let data = r#"{"delta":{"thinking":"Let me consider..."}}"#;
        let events = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Thinking { text } => assert_eq!(text, "Let me consider..."),
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn parses_thinking_from_choices_path() {
        let data = r#"{"choices":[{"delta":{"thinking":"Reasoning step"},"finish_reason":null}]}"#;
        let events = ChatModelWorker::parse_sse_data(data);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WorkerEvent::Thinking { text } => assert_eq!(text, "Reasoning step"),
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn ignores_empty_thinking() {
        let data = r#"{"choices":[{"delta":{"thinking":""},"finish_reason":null}]}"#;
        let events = ChatModelWorker::parse_sse_data(data);
        assert!(events.iter().all(|e| !matches!(e, WorkerEvent::Thinking { .. })));
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

        let body = worker.build_request_body("What is in this image?", &[], &routing, "", &[], &images);

        let messages = body["messages"].as_array().unwrap();
        let user_msg = &messages[messages.len() - 1];
        assert_eq!(user_msg["role"], "user");
        // Should be multimodal content array
        let content = user_msg["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "What is in this image?");
        assert_eq!(content[1]["type"], "image_url");
        assert!(content[1]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
}
