// ABOUTME: Orchestrator worker that routes chat through an organization-managed seren-cloud deployment.
// ABOUTME: Starts async managed runs, streams run snapshots over SSE, and maps cloud events into desktop WorkerEvents.

use async_trait::async_trait;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::auth::authenticated_request;

use super::types::{ImageAttachment, RoutingDecision, WorkerEvent};
use super::worker::Worker;

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const CONNECT_TIMEOUT_SECS: u64 = 30;
/// Maximum time to wait for any chunk of data from the stream before giving up.
/// Cloud agent runs are expected to complete within 10 minutes; this gives headroom
/// while still bounding hangs from dead connections.
const READ_TIMEOUT_SECS: u64 = 600;
const RUN_STREAM_ACCEPT: &str = "text/event-stream";

#[derive(Debug, Deserialize)]
struct DataEnvelope<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
struct RunInvocationResponse {
    run_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct StreamRunPayload {
    data: StreamRunRecord,
}

#[derive(Debug, Deserialize)]
struct StreamRunRecord {
    status: String,
    status_message: Option<String>,
    output: Option<String>,
    output_events: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CloudRunOutputEventEnvelope {
    #[serde(flatten)]
    event: CloudRunOutputEvent,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CloudRunOutputEvent {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        #[serde(default, rename = "duration_ms")]
        _duration_ms: Option<i32>,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Option<String>,
        #[serde(default, rename = "status")]
        _status: Option<String>,
    },
    ToolResult {
        id: String,
        content: String,
        is_error: bool,
    },
    ToolAudit {
        id: String,
        tool: String,
        reason: String,
    },
    Workflow {
        state: String,
        checkpoint_id: Option<String>,
        details: Option<Value>,
    },
    Error {
        message: String,
    },
}

struct StreamState {
    processed_events: usize,
    accumulated_content: String,
    accumulated_thinking: String,
    terminal_emitted: bool,
}

impl StreamState {
    fn new() -> Self {
        Self {
            processed_events: 0,
            accumulated_content: String::new(),
            accumulated_thinking: String::new(),
            terminal_emitted: false,
        }
    }
}

enum StreamControl {
    Continue,
    Stop,
}

pub struct CloudAgentWorker {
    client: reqwest::Client,
    deployment_id: String,
    cancelled: Arc<Mutex<bool>>,
}

impl CloudAgentWorker {
    pub fn new(deployment_id: impl Into<String>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(READ_TIMEOUT_SECS))
            .build()
            .map_err(|error| format!("Failed to build HTTP client: {}", error))?;
        Ok(Self {
            client,
            deployment_id: deployment_id.into(),
            cancelled: Arc::new(Mutex::new(false)),
        })
    }

    async fn send_event(
        event_tx: &mpsc::Sender<WorkerEvent>,
        event: WorkerEvent,
    ) -> Result<(), String> {
        event_tx
            .send(event)
            .await
            .map_err(|error| format!("Failed to send worker event: {}", error))
    }

    async fn create_run(
        &self,
        app: &tauri::AppHandle,
        conversation_id: &str,
        prompt: &str,
    ) -> Result<Uuid, String> {
        let url = format!(
            "{}/publishers/seren-cloud/deployments/{}/runs",
            GATEWAY_BASE_URL, self.deployment_id
        );
        let body = json!({
            "message": prompt,
            "async": true,
            "thread_id": conversation_id,
        })
        .to_string();

        let response = authenticated_request(app, &self.client, move |client, token| {
            client
                .post(&url)
                .bearer_auth(token)
                .header("Content-Type", "application/json")
                .body(body.clone())
        })
        .await?;

        let status = response.status();
        if status != reqwest::StatusCode::ACCEPTED && !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(format!(
                "Cloud agent run creation failed: HTTP {} {}",
                status, message
            ));
        }

        let payload: DataEnvelope<RunInvocationResponse> = response
            .json()
            .await
            .map_err(|error| format!("Failed to parse cloud run response: {}", error))?;

        payload
            .data
            .run_id
            .ok_or_else(|| "Cloud agent did not return a run_id".to_string())
    }

    async fn handle_output_events(
        state: &mut StreamState,
        output_events: Option<&Value>,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<StreamControl, String> {
        let Some(value) = output_events else {
            return Ok(StreamControl::Continue);
        };

        let events: Vec<CloudRunOutputEventEnvelope> = serde_json::from_value(value.clone())
            .map_err(|error| format!("Invalid cloud output events payload: {}", error))?;

        for envelope in events.iter().skip(state.processed_events) {
            match &envelope.event {
                CloudRunOutputEvent::Text { text } => {
                    state.accumulated_content.push_str(text);
                    Self::send_event(event_tx, WorkerEvent::Content { text: text.clone() }).await?;
                }
                CloudRunOutputEvent::Thinking {
                    text,
                    _duration_ms: _,
                } => {
                    if !state.accumulated_thinking.is_empty() {
                        state.accumulated_thinking.push('\n');
                    }
                    state.accumulated_thinking.push_str(text);
                    Self::send_event(event_tx, WorkerEvent::Thinking { text: text.clone() })
                        .await?;
                }
                CloudRunOutputEvent::ToolCall {
                    id,
                    name,
                    arguments,
                    _status: _,
                } => {
                    Self::send_event(
                        event_tx,
                        WorkerEvent::ToolCall {
                            tool_call_id: id.clone(),
                            name: name.clone(),
                            arguments: arguments.clone().unwrap_or_else(|| "{}".to_string()),
                            title: name.clone(),
                        },
                    )
                    .await?;
                }
                CloudRunOutputEvent::ToolResult {
                    id,
                    content,
                    is_error,
                } => {
                    Self::send_event(
                        event_tx,
                        WorkerEvent::ToolResult {
                            tool_call_id: id.clone(),
                            content: content.clone(),
                            is_error: *is_error,
                        },
                    )
                    .await?;
                }
                CloudRunOutputEvent::ToolAudit { id, tool, reason } => {
                    log::info!(
                        "[CloudAgentWorker] Tool audit id={} tool={} reason={}",
                        id,
                        tool,
                        reason
                    );
                }
                CloudRunOutputEvent::Workflow {
                    state: workflow_state,
                    checkpoint_id,
                    details,
                } => {
                    if workflow_state == "awaiting_approval" {
                        let approval_count = details
                            .as_ref()
                            .and_then(|value| value.get("pending_approvals"))
                            .and_then(Value::as_array)
                            .map(|items| items.len())
                            .unwrap_or(0);
                        let checkpoint_suffix = checkpoint_id
                            .as_deref()
                            .map(|id| format!(" (checkpoint {})", id))
                            .unwrap_or_default();
                        let message = if approval_count > 0 {
                            format!(
                                "This conversation is awaiting {} cloud approval(s){} and desktop approval handling is not available yet.",
                                approval_count, checkpoint_suffix
                            )
                        } else {
                            format!(
                                "This conversation is awaiting cloud approval{} and desktop approval handling is not available yet.",
                                checkpoint_suffix
                            )
                        };
                        Self::send_event(event_tx, WorkerEvent::Error { message }).await?;
                        state.terminal_emitted = true;
                        return Ok(StreamControl::Stop);
                    }
                }
                CloudRunOutputEvent::Error { message } => {
                    Self::send_event(
                        event_tx,
                        WorkerEvent::Error {
                            message: message.clone(),
                        },
                    )
                    .await?;
                }
            }
        }

        state.processed_events = events.len();
        Ok(StreamControl::Continue)
    }

    async fn handle_snapshot(
        state: &mut StreamState,
        snapshot: StreamRunRecord,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<StreamControl, String> {
        if matches!(
            Self::handle_output_events(state, snapshot.output_events.as_ref(), event_tx).await?,
            StreamControl::Stop
        ) {
            return Ok(StreamControl::Stop);
        }

        if state.terminal_emitted {
            return Ok(StreamControl::Stop);
        }

        match snapshot.status.as_str() {
            "completed" => {
                let final_content = if state.accumulated_content.is_empty() {
                    snapshot.output.unwrap_or_default()
                } else {
                    state.accumulated_content.clone()
                };
                let thinking = (!state.accumulated_thinking.trim().is_empty())
                    .then_some(state.accumulated_thinking.clone());
                Self::send_event(
                    event_tx,
                    WorkerEvent::Complete {
                        final_content,
                        thinking,
                        cost: None,
                        rlm_steps: None,
                    },
                )
                .await?;
                state.terminal_emitted = true;
                Ok(StreamControl::Stop)
            }
            "failed" | "cancelled" | "canceled" => {
                let message = snapshot
                    .status_message
                    .or(snapshot.output)
                    .unwrap_or_else(|| format!("Cloud agent run {}", snapshot.status));
                Self::send_event(event_tx, WorkerEvent::Error { message }).await?;
                state.terminal_emitted = true;
                Ok(StreamControl::Stop)
            }
            "awaiting_approval" => {
                let message = snapshot.status_message.unwrap_or_else(|| {
                    "This conversation is awaiting cloud approval and desktop approval handling is not available yet."
                        .to_string()
                });
                Self::send_event(event_tx, WorkerEvent::Error { message }).await?;
                state.terminal_emitted = true;
                Ok(StreamControl::Stop)
            }
            _ => Ok(StreamControl::Continue),
        }
    }

    async fn stream_run(
        &self,
        app: &tauri::AppHandle,
        run_id: Uuid,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        let url = format!(
            "{}/publishers/seren-cloud/deployments/{}/runs/{}/stream",
            GATEWAY_BASE_URL, self.deployment_id, run_id
        );

        let response = authenticated_request(app, &self.client, move |client, token| {
            client
                .get(&url)
                .bearer_auth(token)
                .header("Accept", RUN_STREAM_ACCEPT)
        })
        .await?;

        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(format!(
                "Cloud agent stream failed: HTTP {} {}",
                status, message
            ));
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut state = StreamState::new();

        while let Some(chunk) = stream.next().await {
            if *self.cancelled.lock().await {
                return Ok(());
            }

            let chunk = chunk.map_err(|error| format!("Cloud stream read error: {}", error))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            buffer = buffer.replace("\r\n", "\n");

            while let Some(block_end) = buffer.find("\n\n") {
                let block = buffer[..block_end].to_string();
                buffer = buffer[block_end + 2..].to_string();

                if block.trim().is_empty() {
                    continue;
                }

                let mut event_type = String::new();
                let mut data_lines = Vec::new();

                for line in block.lines() {
                    if let Some(value) = line.strip_prefix("event:") {
                        event_type = value.trim().to_string();
                    } else if let Some(value) = line.strip_prefix("data:") {
                        data_lines.push(value.trim().to_string());
                    }
                }

                match event_type.as_str() {
                    "run" => {
                        let data = data_lines.join("\n");
                        if data.is_empty() {
                            continue;
                        }
                        let payload: StreamRunPayload =
                            serde_json::from_str(&data).map_err(|error| {
                                format!("Invalid cloud run stream payload: {}", error)
                            })?;
                        if matches!(
                            Self::handle_snapshot(&mut state, payload.data, event_tx).await?,
                            StreamControl::Stop
                        ) {
                            return Ok(());
                        }
                    }
                    "end" => {
                        if !state.terminal_emitted {
                            let final_content = state.accumulated_content.clone();
                            let thinking = (!state.accumulated_thinking.trim().is_empty())
                                .then_some(state.accumulated_thinking.clone());
                            Self::send_event(
                                event_tx,
                                WorkerEvent::Complete {
                                    final_content,
                                    thinking,
                                    cost: None,
                                    rlm_steps: None,
                                },
                            )
                            .await?;
                        }
                        return Ok(());
                    }
                    "error" => {
                        let message = data_lines.join("\n");
                        Self::send_event(event_tx, WorkerEvent::Error { message }).await?;
                        return Ok(());
                    }
                    "timeout" => {
                        Self::send_event(
                            event_tx,
                            WorkerEvent::Error {
                                message: "Timed out waiting for cloud agent run updates"
                                    .to_string(),
                            },
                        )
                        .await?;
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }

        Ok(())
    }
}

#[async_trait]
impl Worker for CloudAgentWorker {
    fn id(&self) -> &str {
        "cloud_agent"
    }

    async fn execute(
        &self,
        conversation_id: &str,
        prompt: &str,
        _conversation_context: &[Value],
        _routing: &RoutingDecision,
        _skill_content: &str,
        app: &tauri::AppHandle,
        images: &[ImageAttachment],
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        if !images.is_empty() {
            Self::send_event(
                &event_tx,
                WorkerEvent::Error {
                    message: "Attachments are not supported with organization private chat yet."
                        .to_string(),
                },
            )
            .await?;
            return Ok(());
        }

        let run_id = self.create_run(app, conversation_id, prompt).await?;
        self.stream_run(app, run_id, &event_tx).await
    }

    async fn cancel(&self) -> Result<(), String> {
        let mut cancelled = self.cancelled.lock().await;
        *cancelled = true;
        Ok(())
    }
}
