// ABOUTME: Core types for the orchestrator: task classification, worker events, and routing decisions.
// ABOUTME: Defines the data structures that flow between classifier, router, and workers.

use serde::{Deserialize, Serialize};

/// Lightweight skill metadata passed from the frontend for matching.
/// The actual SKILL.md content is on disk — Rust reads it directly when needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRef {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub path: String,
}

/// Task classification produced by the orchestrator's classifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskClassification {
    pub task_type: String,
    pub requires_tools: bool,
    pub requires_file_system: bool,
    pub complexity: TaskComplexity,
    pub relevant_skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskComplexity {
    Simple,
    Moderate,
    Complex,
}

/// Events streamed from a worker back to the orchestrator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkerEvent {
    Content {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        arguments: String,
        title: String,
    },
    ToolResult {
        tool_call_id: String,
        content: String,
        is_error: bool,
    },
    Diff {
        path: String,
        old_text: String,
        new_text: String,
        tool_call_id: Option<String>,
    },
    Complete {
        final_content: String,
        thinking: Option<String>,
        /// Total cost in SerenBucks for this worker's request, reported by Gateway.
        #[serde(skip_serializing_if = "Option::is_none")]
        cost: Option<f64>,
    },
    Error {
        message: String,
    },
}

/// Routing decision made by the orchestrator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingDecision {
    pub worker_type: WorkerType,
    pub model_id: String,
    pub delegation: DelegationType,
    pub reason: String,
    pub selected_skills: Vec<SkillRef>,
    /// Publisher slug for McpPublisher worker (e.g. "firecrawl-serenai").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher_slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerType {
    ChatModel,
    AcpAgent,
    McpPublisher,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DelegationType {
    InLoop,
    FullHandoff,
}

/// Image attachment passed from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub name: String,
    pub mime_type: String,
    pub base64: String,
}

/// User capabilities passed from the frontend per-request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserCapabilities {
    pub has_acp_agent: bool,
    pub agent_type: Option<String>,
    /// The model the user explicitly selected in the UI.
    #[serde(default)]
    pub selected_model: Option<String>,
    pub available_models: Vec<String>,
    pub available_tools: Vec<String>,
    pub installed_skills: Vec<SkillRef>,
}

/// Transition event emitted when the orchestrator switches models.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionEvent {
    pub conversation_id: String,
    pub model_name: String,
    pub task_description: String,
}

/// A sub-task produced by the decomposer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubTask {
    pub id: String,
    pub prompt: String,
    pub classification: TaskClassification,
    /// IDs of sub-tasks that must complete before this one starts.
    pub depends_on: Vec<String>,
}

/// An orchestration plan: the full set of sub-tasks for a prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationPlan {
    pub id: String,
    pub conversation_id: String,
    pub original_prompt: String,
    pub subtasks: Vec<SubTask>,
    pub status: PlanStatus,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Active,
    Completed,
    Cancelled,
    Failed,
}

/// Wrapper for worker events sent to the frontend with conversation context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestratorEvent {
    pub conversation_id: String,
    pub worker_event: WorkerEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtask_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_classification_serializes_to_json() {
        let classification = TaskClassification {
            task_type: "code_generation".to_string(),
            requires_tools: true,
            requires_file_system: true,
            complexity: TaskComplexity::Moderate,
            relevant_skills: vec!["prose".to_string()],
        };

        let json = serde_json::to_value(&classification).unwrap();
        assert_eq!(json["task_type"], "code_generation");
        assert_eq!(json["requires_tools"], true);
        assert_eq!(json["requires_file_system"], true);
        assert_eq!(json["complexity"], "moderate");
        assert_eq!(json["relevant_skills"], serde_json::json!(["prose"]));
    }

    #[test]
    fn worker_event_variants_serialize_with_type_tag() {
        let content = WorkerEvent::Content {
            text: "hello".to_string(),
        };
        let json = serde_json::to_value(&content).unwrap();
        assert_eq!(json["type"], "content");
        assert_eq!(json["text"], "hello");

        let thinking = WorkerEvent::Thinking {
            text: "hmm".to_string(),
        };
        let json = serde_json::to_value(&thinking).unwrap();
        assert_eq!(json["type"], "thinking");
        assert_eq!(json["text"], "hmm");

        let tool_call = WorkerEvent::ToolCall {
            tool_call_id: "tc1".to_string(),
            name: "read_file".to_string(),
            arguments: r#"{"path":"/tmp/foo"}"#.to_string(),
            title: "Read file".to_string(),
        };
        let json = serde_json::to_value(&tool_call).unwrap();
        assert_eq!(json["type"], "tool_call");
        assert_eq!(json["tool_call_id"], "tc1");
        assert_eq!(json["name"], "read_file");

        let tool_result = WorkerEvent::ToolResult {
            tool_call_id: "tc1".to_string(),
            content: "file contents".to_string(),
            is_error: false,
        };
        let json = serde_json::to_value(&tool_result).unwrap();
        assert_eq!(json["type"], "tool_result");
        assert_eq!(json["is_error"], false);

        let diff = WorkerEvent::Diff {
            path: "src/main.rs".to_string(),
            old_text: "old".to_string(),
            new_text: "new".to_string(),
            tool_call_id: Some("tc2".to_string()),
        };
        let json = serde_json::to_value(&diff).unwrap();
        assert_eq!(json["type"], "diff");
        assert_eq!(json["path"], "src/main.rs");
        assert_eq!(json["tool_call_id"], "tc2");

        let complete = WorkerEvent::Complete {
            final_content: "done".to_string(),
            thinking: None,
            cost: Some(0.005),
        };
        let json = serde_json::to_value(&complete).unwrap();
        assert_eq!(json["type"], "complete");
        assert_eq!(json["thinking"], serde_json::Value::Null);
        assert_eq!(json["cost"], 0.005);

        // cost: None should be omitted from serialized JSON
        let complete_no_cost = WorkerEvent::Complete {
            final_content: "done".to_string(),
            thinking: None,
            cost: None,
        };
        let json = serde_json::to_value(&complete_no_cost).unwrap();
        assert!(json.get("cost").is_none());

        let error = WorkerEvent::Error {
            message: "oops".to_string(),
        };
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["type"], "error");
        assert_eq!(json["message"], "oops");
    }

    #[test]
    fn worker_event_deserializes_from_json() {
        let json = r#"{"type":"content","text":"hello world"}"#;
        let event: WorkerEvent = serde_json::from_str(json).unwrap();
        match event {
            WorkerEvent::Content { text } => assert_eq!(text, "hello world"),
            _ => panic!("Expected Content variant"),
        }

        let json = r#"{"type":"error","message":"something failed"}"#;
        let event: WorkerEvent = serde_json::from_str(json).unwrap();
        match event {
            WorkerEvent::Error { message } => assert_eq!(message, "something failed"),
            _ => panic!("Expected Error variant"),
        }
    }

    #[test]
    fn routing_decision_round_trips_through_serde() {
        let decision = RoutingDecision {
            worker_type: WorkerType::AcpAgent,
            model_id: "anthropic/claude-opus-4-6".to_string(),
            delegation: DelegationType::InLoop,
            reason: "Code generation task with file system access".to_string(),
            selected_skills: vec![SkillRef {
                slug: "prose".to_string(),
                name: "Prose".to_string(),
                description: "AI writing assistant".to_string(),
                tags: vec!["writing".to_string()],
                path: "/skills/prose/SKILL.md".to_string(),
            }],
            publisher_slug: None,
        };

        let json = serde_json::to_string(&decision).unwrap();
        let deserialized: RoutingDecision = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.worker_type, WorkerType::AcpAgent);
        assert_eq!(deserialized.model_id, "anthropic/claude-opus-4-6");
        assert_eq!(deserialized.delegation, DelegationType::InLoop);
        assert_eq!(
            deserialized.reason,
            "Code generation task with file system access"
        );
        assert_eq!(deserialized.selected_skills.len(), 1);
        assert_eq!(deserialized.selected_skills[0].slug, "prose");
    }

    #[test]
    fn worker_type_serializes_as_snake_case() {
        let json = serde_json::to_value(WorkerType::ChatModel).unwrap();
        assert_eq!(json, "chat_model");

        let json = serde_json::to_value(WorkerType::AcpAgent).unwrap();
        assert_eq!(json, "acp_agent");

        let json = serde_json::to_value(WorkerType::McpPublisher).unwrap();
        assert_eq!(json, "mcp_publisher");
    }

    #[test]
    fn delegation_type_serializes_as_snake_case() {
        let json = serde_json::to_value(DelegationType::InLoop).unwrap();
        assert_eq!(json, "in_loop");

        let json = serde_json::to_value(DelegationType::FullHandoff).unwrap();
        assert_eq!(json, "full_handoff");
    }

    #[test]
    fn transition_event_serializes_correctly() {
        let event = TransitionEvent {
            conversation_id: "abc-123".to_string(),
            model_name: "Claude Opus".to_string(),
            task_description: "code generation".to_string(),
        };

        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["conversation_id"], "abc-123");
        assert_eq!(json["model_name"], "Claude Opus");
        assert_eq!(json["task_description"], "code generation");
    }

    #[test]
    fn user_capabilities_deserializes_from_frontend_json() {
        let json = r#"{
            "has_acp_agent": true,
            "agent_type": "claude-code",
            "available_models": ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4"],
            "available_tools": ["firecrawl", "run_sql"],
            "installed_skills": [{
                "slug": "prose",
                "name": "Prose",
                "description": "Writing assistant",
                "tags": ["writing", "ai"],
                "path": "/skills/prose/SKILL.md"
            }]
        }"#;

        let caps: UserCapabilities = serde_json::from_str(json).unwrap();
        assert!(caps.has_acp_agent);
        assert_eq!(caps.agent_type, Some("claude-code".to_string()));
        assert_eq!(caps.available_models.len(), 2);
        assert_eq!(caps.available_tools.len(), 2);
        assert_eq!(caps.installed_skills.len(), 1);
        assert_eq!(caps.installed_skills[0].slug, "prose");
    }
}
